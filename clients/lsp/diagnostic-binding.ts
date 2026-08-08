import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { PathKeyedMap } from "../path-keyed-map.js";
import { normalizeEphemeralMapKey } from "../path-utils.js";

/**
 * #1095: bind LSP diagnostics to the document CONTENT they were computed
 * against, instead of inferring staleness purely from mtime/TTL proxies.
 *
 * A `publishDiagnostics` notification carries an optional `version` (the
 * document version the diagnostics apply to). pi-lens already owns the
 * didOpen/didChange version counter and the exact text it sent at each
 * version, so at SEND time it can fingerprint that text and, when the server
 * echoes a `version`, bind the stored diagnostics to that fingerprint. A
 * consumer can then ask "were these diagnostics computed against what's on
 * disk NOW?" by comparing the fingerprint to the current file bytes — a real
 * content check rather than an mtime proxy.
 */

/**
 * true  → the diagnostics' fingerprint matches the current disk bytes.
 * false → it demonstrably does NOT (the server's view diverged from disk).
 * "unknown" → cannot be determined (server never reported a version, so no
 *   fingerprint was captured; or the file could not be stat'd/read). "unknown"
 *   is the honest #533 fallback — never rendered as false-clean OR false-live —
 *   and preserves EXACTLY the pre-#1095 behavior for servers that never bind.
 */
export type BoundToCurrentDisk = boolean | "unknown";

/**
 * The stored half of a binding: what a per-file diagnostics entry was computed
 * against. Captured at publish time on the owning client (see
 * `LSPClientState.diagnosticBindings`). Both fields are absent for a version-
 * less publish; `contentHash` is present only when a server-reported version
 * matched the client's last-sent version for that document.
 */
export interface StoredDiagnosticBinding {
	/** The `publishDiagnostics.version` the diagnostics were computed against. */
	version?: number;
	/** sha256 of the EXACT didOpen/didChange payload text for that version. */
	contentHash?: string;
}

/**
 * The read-time binding surfaced to consumers: the stored half plus the lazily
 * computed disk verdict.
 */
export interface DiagnosticBinding extends StoredDiagnosticBinding {
	boundToCurrentDisk: BoundToCurrentDisk;
}

/**
 * Fingerprint the EXACT text handed to didOpen/didChange. sha256 over the raw
 * string — no normalization — so the disk comparison (which reads the file with
 * the SAME raw `utf-8` transform pi-lens builds LSP payloads with) round-trips
 * CRLF and BOM bytes identically. See `createDiskBindingCache`.
 */
export function hashDiagnosticContent(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

/**
 * Compose the merged `boundToCurrentDisk` across every client contributing to a
 * merged diagnostics result (primary + auxiliaries). The merged set is only as
 * trustworthy as its least-bound contributor:
 *   - ANY contributor demonstrably mismatches disk        → false
 *   - otherwise, all contributors are "unknown" (or none) → "unknown"
 *   - otherwise (≥1 bound, none mismatched)               → true
 * Unknowns never block a `true`: a version-less auxiliary alongside a bound
 * primary must not erase the primary's binding, only a real mismatch does.
 */
export function composeBoundToCurrentDisk(
	values: readonly BoundToCurrentDisk[],
): BoundToCurrentDisk {
	if (values.some((v) => v === false)) return false;
	if (values.length === 0 || values.every((v) => v === "unknown")) {
		return "unknown";
	}
	return true;
}

/** One-word summary of a binding verdict for latency/observability logs. */
export function bindingStateLabel(
	value: BoundToCurrentDisk,
): "bound" | "mismatch" | "unknown" {
	if (value === true) return "bound";
	if (value === false) return "mismatch";
	return "unknown";
}

/**
 * Lazily verify a stored binding against current disk, memoizing the disk
 * fingerprint per (file, mtime) so repeated reads within a sweep don't re-hash
 * unchanged files. Cheapness contract (#1095): stat the file first and only
 * read+hash when the mtime differs from the memoized entry.
 *
 * READ-TRANSFORM SYMMETRY (the CRLF/BOM invariant): pi-lens builds every LSP
 * didOpen/didChange payload from `fs.readFile(path, "utf-8")` (raw UTF-8 — no
 * BOM strip, no EOL normalization). This verifier reads disk with the identical
 * `readFileSync(path, "utf-8")` so a Windows CRLF(+BOM) file whose bytes are
 * unchanged fingerprints identically and binds `true`. Any divergence here
 * would make every Windows file spuriously mismatch.
 */
export interface DiskBindingCache {
	boundToCurrentDisk(
		filePath: string,
		stored: StoredDiagnosticBinding,
	): BoundToCurrentDisk;
}

/**
 * Bound on the per-(file,mtime) disk-fingerprint memo. The memo grows by one
 * entry per distinct tracked file; a full clear on overflow (rather than an LRU)
 * is fine because each entry is a pure, cheaply-recomputed derivation of disk
 * bytes — the worst case after a clear is one extra re-hash per file. Keeps the
 * map from growing unbounded across a long-lived session.
 */
const DISK_BINDING_MEMO_MAX = 4096;

export function createDiskBindingCache(): DiskBindingCache {
	// #1025: key through PathKeyedMap + normalizeEphemeralMapKey so two forms of
	// the same path (`SUB\a.ts` vs `sub/a.ts`) can't produce a duplicate memo or a
	// false miss. Ephemeral (slash-fold + win32-lowercase, no realpath I/O) — the
	// keys are file paths this process is already stat'ing on the hot read path.
	const diskHashByPath = new PathKeyedMap<{ mtimeMs: number; hash: string }>(
		normalizeEphemeralMapKey,
	);
	return {
		boundToCurrentDisk(filePath, stored) {
			// No fingerprint captured (version-less server) → unknown, never false.
			if (stored.contentHash === undefined) return "unknown";
			let mtimeMs: number;
			try {
				mtimeMs = fs.statSync(filePath).mtimeMs;
			} catch {
				// Can't stat (deleted/unreadable): can't disprove the binding either,
				// so stay honest — "unknown", never a manufactured false.
				return "unknown";
			}
			let cached = diskHashByPath.get(filePath);
			if (!cached || cached.mtimeMs !== mtimeMs) {
				let diskHash: string;
				try {
					diskHash = hashDiagnosticContent(fs.readFileSync(filePath, "utf-8"));
				} catch {
					return "unknown";
				}
				cached = { mtimeMs, hash: diskHash };
				if (diskHashByPath.size >= DISK_BINDING_MEMO_MAX) {
					diskHashByPath.clear();
				}
				diskHashByPath.set(filePath, cached);
			}
			return cached.hash === stored.contentHash;
		},
	};
}
