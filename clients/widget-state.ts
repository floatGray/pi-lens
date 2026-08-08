import { stat } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { visibleWidth } from "./deps/pi-tui.js";
import { normalizeEphemeralMapKey } from "./path-utils.js";
import { fitLine } from "./tui-fit.js";
import { WriteOrderingGuard } from "./write-ordering-guard.js";

/**
 * Canonical key for the `files` map (and `diagnosticsWriteGuard`) — #1020.
 *
 * The SAME file reaches this module under DIFFERENT path forms in one session:
 * forward-slash (`C:/…/x.ts`) from the LSP client + cascade fold via
 * `normalizeFilePath`, and backslash (`C:\…\x.ts`) from mode=full's reconcile
 * writing `result.filePath` and from `path.resolve`/event inputs on Windows.
 * Keyed raw, those coexisted as two entries: `mode=full` re-keyed on read and
 * the clean entry hid the stale one, but `mode=all`'s `formatAllMode` reads the
 * summaries verbatim and rendered the stale `blocking:1` as a 🔴 (#1020) — a
 * resolved state that replayed as still-broken on every `mode=all`.
 *
 * `normalizeEphemeralMapKey` (slash-fold + win32-lowercase, NO filesystem I/O)
 * is chosen over `normalizeMapKey`/`normalizeFilePath`, which call
 * `realpathSync.native()` — real disk I/O on EVERY diagnostic/runner/formatter
 * write, far too heavy for this hot path. The key only needs to be a stable
 * syntactic fold that collapses `\`↔`/` and Windows drive-letter case, which
 * this does; on-disk canonical casing is irrelevant for merely deduplicating a
 * process-local footer cache. The human-readable path is preserved separately
 * on the record's `filePath` (see `toDisplayPath`) for rendering/summaries.
 */
function fileMapKey(filePath: string): string {
	return normalizeEphemeralMapKey(filePath);
}

// The record keeps a real, human-readable display path in `FileRecord.filePath`
// (drives the widget render, `getFileDiagnosticSummaries`, and diagnostic URIs).
// It is the VERBATIM path the first writer for a given key supplied — never the
// lowercased/normalized `fileMapKey`, which would render an ugly all-lowercase
// path on Windows. Only the MAP KEY is normalized; the display path is
// unchanged from pre-#1020 behavior, so rendering and path-relative math are
// unaffected. First writer wins the display form (later writes for the same
// normalized key reuse the existing record).

// ── Types ────────────────────────────────────────────────────────────────────

export interface WidgetDiagnostic {
	severity: string;
	semantic?: string;
	message: string;
	line?: number;
	col?: number;
	rule?: string;
	tool?: string;
	uri?: string;
	/** Set when a `flagged` disposition (#690) is found for this diagnostic at
	 * merge time — only populated where file content was already available
	 * (mode=full's suppression pass), never computed for mode=all/delta to
	 * keep those cache-only and instant. */
	flagged?: boolean;
}

/**
 * A diagnostic is "blocking" when pi-lens classifies it as a hard stop
 * (`semantic === "blocking"`). Falls back to severity for sources that
 * don't set `semantic` (raw tsc/eslint diagnostics) so the red dot still
 * fires on traditional compile errors.
 */
function isBlocking(d: WidgetDiagnostic): boolean {
	if (d.semantic === "blocking") return true;
	if (d.semantic == null && d.severity === "error") return true;
	return false;
}

interface FileRecord {
	filePath: string;
	runners: Map<string, { status: string; count: number; durationMs?: number }>;
	formatters: Map<string, { changed: boolean; success: boolean }>;
	/** Capped to MAX_STORED_DIAGNOSTICS_PER_FILE — drives the TUI widget. */
	diagnostics: WidgetDiagnostic[];
	/**
	 * Full, uncapped diagnostics for this file. The TUI never renders these
	 * (it uses the capped `diagnostics` + its own row limits); they exist so
	 * the lens_diagnostics tool can expose the complete set to the agent without
	 * inheriting the widget's display cap.
	 */
	allDiagnostics: WidgetDiagnostic[];
	diagnosticCounts: {
		blocking: number;
		errors: number;
		warnings: number;
	};
	hasFinalDiagnosticsSnapshot: boolean;
	touchedAt: number;
}

interface LspRecord {
	serverId: string;
	root: string;
	status: "spawning" | "ready" | "failed";
	durationMs?: number;
}

// ── Module state ─────────────────────────────────────────────────────────────

const files = new Map<string, FileRecord>();
const lspServers = new Map<string, LspRecord>();
let sessionLanguages: string[] = [];
let requestRenderFn: (() => void) | null = null;

/**
 * Guards `recordDiagnostics` writes against the same race class fixed for
 * `clients/lsp/client.ts` in #555: pi-lens allows concurrent pipeline runs
 * for the same file across different same-turn edits, so an older edit's
 * (slower) pipeline can finish its `recordDiagnostics` call AFTER a newer
 * edit's (faster) pipeline already recorded fresher diagnostics for that
 * path. Keyed by `filePath`, tokened by `writeIndex` (see
 * `clients/runtime-tool-result.ts:nextWriteIndex`).
 */
const diagnosticsWriteGuard = new WriteOrderingGuard<string, number>();

const MAX_STORED_DIAGNOSTICS_PER_FILE = 12;

// ── Public API ────────────────────────────────────────────────────────────────

export function setRenderCallback(fn: () => void): void {
	requestRenderFn = fn;
}

export function clearWidgetState(): void {
	files.clear();
	lspServers.clear();
	sessionLanguages = [];
	requestRenderFn = null;
	diagnosticsWriteGuard.clear();
}

export const WIDGET_STATE_VERSION = 1;

/** Serializable snapshot of the per-file diagnostic state (#190). */
export interface PersistedWidgetState {
	version: number;
	sessionLanguages: string[];
	files: Array<{
		filePath: string;
		runners: Array<
			[string, { status: string; count: number; durationMs?: number }]
		>;
		formatters: Array<[string, { changed: boolean; success: boolean }]>;
		diagnostics: WidgetDiagnostic[];
		allDiagnostics: WidgetDiagnostic[];
		diagnosticCounts: { blocking: number; errors: number; warnings: number };
		hasFinalDiagnosticsSnapshot: boolean;
		touchedAt: number;
	}>;
}

/**
 * Snapshot the per-file widget diagnostics for persistence (#190). Excludes
 * `lspServers` — those are process-bound (servers re-spawn fresh on the next
 * launch), so restoring their "ready" status would be misleading.
 */
export function exportWidgetState(): PersistedWidgetState {
	return {
		version: WIDGET_STATE_VERSION,
		sessionLanguages: [...sessionLanguages],
		files: [...files.values()].map((rec) => ({
			filePath: rec.filePath,
			runners: [...rec.runners.entries()],
			formatters: [...rec.formatters.entries()],
			diagnostics: rec.diagnostics,
			allDiagnostics: rec.allDiagnostics,
			diagnosticCounts: rec.diagnosticCounts,
			hasFinalDiagnosticsSnapshot: rec.hasFinalDiagnosticsSnapshot,
			touchedAt: rec.touchedAt,
		})),
	};
}

/**
 * Restore a {@link PersistedWidgetState} snapshot (#190 resume rehydration).
 * Replaces the in-memory `files` map; ignores snapshots from a different
 * version. Triggers a re-render if a callback is registered.
 */
export function importWidgetState(state: PersistedWidgetState | undefined): boolean {
	if (!state || state.version !== WIDGET_STATE_VERSION) return false;
	files.clear();
	// A resumed session's writeIndex counter starts fresh (#190 rehydration is
	// process-bound like lspServers, see the export above) — any ordering
	// tokens tracked before the restore no longer correspond to anything, so
	// drop them rather than risk a legitimate post-resume write being read as
	// "superseded" against a stale token.
	diagnosticsWriteGuard.clear();
	for (const f of state.files ?? []) {
		// Fold persisted keys through the same normalizer as live writes (#1020),
		// or a persisted forward-slash key stays split from a fresh backslash key
		// across a resumed session — a primary repro condition. Keep a readable
		// display path on the record.
		files.set(fileMapKey(f.filePath), {
			filePath: f.filePath,
			runners: new Map(f.runners ?? []),
			formatters: new Map(f.formatters ?? []),
			diagnostics: f.diagnostics ?? [],
			allDiagnostics: f.allDiagnostics ?? [],
			diagnosticCounts: f.diagnosticCounts ?? {
				blocking: 0,
				errors: 0,
				warnings: 0,
			},
			hasFinalDiagnosticsSnapshot: f.hasFinalDiagnosticsSnapshot ?? false,
			touchedAt: f.touchedAt ?? Date.now(),
		});
	}
	sessionLanguages = state.sessionLanguages ?? [];
	requestRenderFn?.();
	return true;
}

export function setSessionLanguages(langs: string[]): void {
	sessionLanguages = langs;
	requestRender();
}

/** File-kinds detected in use this session (#170 staleness scope). */
export function getSessionLanguages(): string[] {
	return [...sessionLanguages];
}

/**
 * Distinct serverIds with a failed spawn record (#170). Raw — the per-language
 * coverage check (a live sibling) and the in-use staleness filter live in
 * `selectLspStatus`, which joins this against the alive set and session kinds.
 */
export function getFailedLspServerIds(): string[] {
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const rec of lspServers.values()) {
		if (rec.status !== "failed" || seen.has(rec.serverId)) continue;
		seen.add(rec.serverId);
		ids.push(rec.serverId);
	}
	return ids;
}

export function recordFormatter(
	filePath: string,
	formatter: string,
	changed: boolean,
	success: boolean,
): void {
	const rec = getOrCreate(filePath);
	rec.formatters.set(formatter, { changed, success });
	rec.touchedAt = Date.now();
	files.set(fileMapKey(filePath), rec);
	requestRender();
}

export function recordRunner(
	filePath: string,
	runnerId: string,
	status: string,
	diagnosticCount: number,
	durationMs?: number,
): void {
	const rec = getOrCreate(filePath);
	rec.runners.set(runnerId, { status, count: diagnosticCount, durationMs });
	rec.hasFinalDiagnosticsSnapshot = false;
	rec.touchedAt = Date.now();
	files.set(fileMapKey(filePath), rec);
	requestRender();
}

/**
 * Collapse a (possibly multi-line) diagnostic message to a single line.
 * TS2769 / "no overload matches" and many compiler errors are multi-line;
 * embedded newlines/tabs would otherwise render across several widget rows
 * (and break the `L<line>: <message>` inline-blocker format), so flatten all
 * whitespace runs to a single space before storing.
 */
function toSingleLineMessage(message: string | undefined): string {
	return (message ?? "").replace(/\s+/g, " ").trim();
}

export function recordDiagnostics(
	filePath: string,
	diagnostics: Array<{
		tool?: string;
		rule?: string;
		id?: string;
		message?: string;
		line?: number;
		column?: number;
		severity?: string;
		semantic?: string;
	}>,
	writeIndex?: number,
	// #1093: when the truth was OBSERVED, not when it's being written. Defaults
	// to `Date.now()` for the per-edit/live path (observed now). A reconcile
	// replaying a CACHED view (e.g. the workspace-diagnostics cache-hit branch in
	// `tools/lsp-diagnostics.ts`) must pass the cache entry's own scan timestamp
	// here — otherwise a repeat "fresh check" that merely re-serves a stale
	// cached view keeps bumping `touchedAt` to now(), permanently disarming
	// `reconcileStaleWidgetFiles`'s `mtimeMs > touchedAt` gate so a resolved
	// finding renders forever (the #1092 touchedAt-re-arming defect).
	observedAt?: number,
): void {
	// Drop a write that's superseded by a later same-turn edit to this file
	// whose pipeline finished first (same race class as #555). No cache write,
	// no count/timestamp update, no render trigger — the recorded state must
	// stay exactly as the fresher write left it. `writeIndex` omitted (e.g.
	// the `clients/mcp/analyze.ts` on-demand call site, which has no per-edit
	// ordering token) always proceeds, same as version-less LSP servers in the
	// #555 guard.
	if (!diagnosticsWriteGuard.shouldWrite(fileMapKey(filePath), writeIndex)) return;

	const rec = getOrCreate(filePath);
	commitDiagnostics(rec, filePath, normalizeDiagnostics(filePath, diagnostics), observedAt);
}

/** Map the raw diagnostic shape callers pass into stored {@link WidgetDiagnostic}s. */
function normalizeDiagnostics(
	filePath: string,
	diagnostics: Array<{
		tool?: string;
		rule?: string;
		id?: string;
		message?: string;
		line?: number;
		column?: number;
		severity?: string;
		semantic?: string;
	}>,
): WidgetDiagnostic[] {
	const base = pathToFileURL(filePath).href;
	return diagnostics.map((d) => {
		const rule = d.rule ?? d.id;
		const uri =
			d.line != null
				? `${base}#L${d.line}${d.column != null ? `:${d.column}` : ""}`
				: base;
		return {
			severity: d.severity ?? "info",
			semantic: d.semantic,
			message: toSingleLineMessage(d.message),
			line: d.line,
			col: d.column,
			rule,
			tool: d.tool,
			uri,
		} satisfies WidgetDiagnostic;
	});
}

/** Store `normalized` as the record's complete diagnostic set: recompute counts,
 * cap the display list, stamp `touchedAt` (at `observedAt` when given, else now
 * — #1093), persist, and re-render. The caller decides what `normalized`
 * contains (a full replace, or a merge — see `reconcileCascadeNeighborLspErrors`). */
function commitDiagnostics(
	rec: FileRecord,
	filePath: string,
	normalized: WidgetDiagnostic[],
	observedAt: number | undefined,
): void {
	let blocking = 0;
	let errors = 0;
	let warnings = 0;
	for (const diagnostic of normalized) {
		if (isBlocking(diagnostic)) blocking++;
		if (diagnostic.severity === "error") errors++;
		else if (diagnostic.severity === "warning") warnings++;
	}

	rec.diagnosticCounts = { blocking, errors, warnings };
	rec.diagnostics = capStoredDiagnostics(normalized);
	rec.allDiagnostics = normalized;
	rec.hasFinalDiagnosticsSnapshot = true;
	rec.touchedAt = observedAt ?? Date.now();
	files.set(fileMapKey(filePath), rec);
	requestRender();
}

/**
 * A stored diagnostic that came from a language SERVER (tsserver, pyright, …)
 * AND is an error/blocking finding. `convertLspDiagnostics` tags every
 * language-server diagnostic with `tool: "lsp"` and `retagAuxiliaryDiagnostics`
 * re-tags auxiliary-LSP findings (opengrep/ast-grep/zizmor/typos) to their real
 * tool id, so `tool === "lsp"` uniquely identifies a genuine language-server
 * entry. Used by the cascade merge below to decide which existing entries an
 * errors-only LSP re-check is entitled to replace.
 */
function isLspErrorEntry(d: WidgetDiagnostic): boolean {
	return d.tool === "lsp" && (d.semantic === "blocking" || d.severity === "error");
}

/**
 * Reconcile a CONFIRMED cascade neighbor re-check (#1093) into the footer,
 * MERGING rather than whole-replacing (unlike `recordDiagnostics`).
 *
 * The cascade only re-checks a neighbor through its LANGUAGE SERVER, and only
 * for ERRORS (`severity === 1`; see `clients/dispatch/integration.ts`). A plain
 * full-replace would therefore erase the neighbor's live findings from OTHER
 * sources that the cascade never re-examined — biome/ruff/ast-grep runner
 * findings, and even the language server's own WARNINGS — turning a
 * cross-file-error re-check into a silent false-clean for everything else
 * (#533). So we replace ONLY the existing LSP-error entries
 * (`isLspErrorEntry`) with the cascade's fresh LSP errors and preserve
 * everything else verbatim. A stale LSP warning or biome finding therefore
 * survives an errors-only cascade — correct, because this check never looked at
 * it; it self-corrects on the next per-edit dispatch or a `lens_diagnostics`
 * scan (which DO re-examine every source).
 *
 * Only ever call this for a CONFIRMED result (a valid passive snapshot or a
 * completed, NON-inconclusive active touch — #571). `writeIndex` and
 * `observedAt` behave exactly as in `recordDiagnostics`.
 */
export function reconcileCascadeNeighborLspErrors(
	filePath: string,
	lspErrorDiagnostics: Array<{
		tool?: string;
		rule?: string;
		id?: string;
		message?: string;
		line?: number;
		column?: number;
		severity?: string;
		semantic?: string;
	}>,
	writeIndex?: number,
	observedAt?: number,
): void {
	if (!diagnosticsWriteGuard.shouldWrite(fileMapKey(filePath), writeIndex)) return;
	const rec = getOrCreate(filePath);
	const incoming = normalizeDiagnostics(filePath, lspErrorDiagnostics);
	const preserved = rec.allDiagnostics.filter((d) => !isLspErrorEntry(d));
	commitDiagnostics(rec, filePath, [...incoming, ...preserved], observedAt);
}

/**
 * Reconcile a diagnostics result obtained OUTSIDE the per-edit dispatch
 * pipeline — a `lens_diagnostics` mode=full workspace scan, or a standalone
 * `lsp_diagnostics` on-demand check — into the footer cache (#571).
 *
 * `recordDiagnostics` is otherwise only reachable from `pipeline.ts`'s
 * per-edit dispatch, so a file that becomes stale/fresh purely because of a
 * change to some OTHER file it depends on (and is never itself re-edited
 * through pi-lens) has no path to correct the footer — a full scan proves
 * the fresher truth but had nowhere to put it. This is that path, shared by
 * both call sites so there's exactly one place that decides whether a scan
 * result is trustworthy enough to write.
 *
 * `confirmed` MUST be false for any result the caller can't vouch for — a
 * timed-out/inconclusive LSP check (see #570) must never present as
 * "confirmed clean" in the footer, and must not clobber a real prior
 * confirmed-dirty entry either. Non-confirmed results are silently skipped,
 * leaving whatever the footer already had (stale-but-real beats
 * fresh-but-fabricated).
 *
 * `writeIndex` should be a freshly-drawn token from the same monotonic
 * source the per-edit pipeline uses (`RuntimeCoordinator.nextWriteIndex()`)
 * so `recordDiagnostics`'s existing `WriteOrderingGuard` (#555) can tell a
 * scan-originated write apart from a concurrent, genuinely newer per-edit
 * write for the same file — an omitted `writeIndex` always proceeds (same
 * version-less fallback `recordDiagnostics` already documents), which is
 * only safe for callers with no ordering token to give (e.g. tests).
 *
 * `observedAt` (#1093) is the wall-clock time the diagnostics were actually
 * OBSERVED — pass it whenever the reconciled result is a replay of an older
 * CACHED observation (the workspace-diagnostics cache-hit branch), so
 * `touchedAt` records when the truth was seen, not when it was written. Omit
 * it for genuinely fresh observations (a just-completed touch/scan), which are
 * observed now.
 */
export function reconcileScanDiagnostics(
	filePath: string,
	diagnostics: Array<{
		tool?: string;
		rule?: string;
		id?: string;
		message?: string;
		line?: number;
		column?: number;
		severity?: string;
		semantic?: string;
	}>,
	confirmed: boolean,
	writeIndex?: number,
	observedAt?: number,
): void {
	if (!confirmed) return;
	recordDiagnostics(filePath, diagnostics, writeIndex, observedAt);
}

/**
 * Drop widget entries whose file changed on disk after pi-lens last recorded
 * them (`mtimeMs > touchedAt` → the recorded diagnostics predate the current
 * content → stale) or that no longer exist. Keeps `lens_diagnostics` from
 * surfacing findings the agent already fixed (or that an external edit
 * invalidated). Async with concurrent stats — call on read, never on the typing
 * path. Returns how many entries were dropped (so callers can tell the agent
 * those files changed and need a `mode=full` rescan rather than reading as
 * clean).
 */
export async function reconcileStaleWidgetFiles(): Promise<number> {
	const entries = [...files.entries()];
	const staleKeys = await Promise.all(
		// `mapKey` is the normalized `files` key (used for deletion); stat the
		// record's real display path, not the lowercased key (#1020).
		entries.map(async ([mapKey, rec]) => {
			try {
				const st = await stat(rec.filePath);
				// +1ms tolerance: a freshly-recorded file has touchedAt >= mtime.
				return st.mtimeMs > rec.touchedAt + 1 ? mapKey : undefined;
			} catch {
				return mapKey; // deleted / unreadable → drop
			}
		}),
	);
	let dropped = 0;
	for (const key of staleKeys) {
		if (key !== undefined) {
			files.delete(key);
			dropped += 1;
		}
	}
	if (dropped > 0) requestRenderFn?.();
	return dropped;
}

/**
 * Keep the TUI honest (#298 follow-up). `reconcileStaleWidgetFiles` drops
 * widget entries whose file changed on disk after they were last recorded
 * (i.e. diagnostics the agent already fixed) — but it was only ever wired
 * into the `lens_diagnostics` tool, so the widget rendered cached diagnostics
 * verbatim and kept showing fixed errors until `lens_diagnostics` was run by
 * hand. This debounced scheduler fires it from the widget render path (see
 * `mountLensWidget` in index.ts) so stale entries self-correct. The debounce
 * collapses the burst of renders that accompany a save into a single sweep.
 */
let staleReconcileTimer: ReturnType<typeof setTimeout> | null = null;
export const STALE_RECONCILE_DEBOUNCE_MS = 1500;
export function scheduleStaleReconcile(): void {
	if (staleReconcileTimer !== null) return;
	staleReconcileTimer = setTimeout(() => {
		staleReconcileTimer = null;
		void reconcileStaleWidgetFiles().catch(() => {});
	}, STALE_RECONCILE_DEBOUNCE_MS);
	// Don't keep the process alive solely for this background sweep.
	staleReconcileTimer?.unref?.();
}

/** Summary of current diagnostic counts across all files in the widget. */
export interface FileDiagnosticSummary {
	filePath: string;
	blocking: number;
	errors: number;
	warnings: number;
	hasFinalSnapshot: boolean;
	/**
	 * The full, uncapped diagnostics for this file (not limited by the TUI's
	 * per-file storage cap). `blocking + errors + warnings` may exceed
	 * `diagnostics.length` because a single diagnostic can be both blocking and
	 * an error — these are the actual records, deduplicated by the runners.
	 */
	diagnostics: WidgetDiagnostic[];
}

/**
 * Return current diagnostics for every file pi-lens has seen this session.
 * Used by lens_diagnostics tool (mode: "all"). Exposes the FULL per-file
 * diagnostic set — decoupled from the widget's display cap — so the agent sees
 * everything, not just the 12 the TUI keeps for rendering.
 */
export function getFileDiagnosticSummaries(): FileDiagnosticSummary[] {
	return [...files.values()].map((rec) => ({
		filePath: rec.filePath,
		blocking: rec.diagnosticCounts.blocking,
		errors: rec.diagnosticCounts.errors,
		warnings: rec.diagnosticCounts.warnings,
		hasFinalSnapshot: rec.hasFinalDiagnosticsSnapshot,
		diagnostics: rec.allDiagnostics.map((d) => ({ ...d })),
	}));
}

/**
 * Return the current FULL (uncapped) diagnostic set for a single file, as
 * last recorded by {@link recordDiagnostics} — the same `allDiagnostics`
 * store `getFileDiagnosticSummaries` exposes per-file, without paying for a
 * whole-session snapshot. Used by the #502 `pilens:diagnostics` bus producer
 * (`clients/bus-publish.ts`), which reads this immediately after
 * `recordDiagnostics` writes it so the emitted event reflects the write
 * batch's FINAL diagnostic state (post-format, post-autofix, post-dispatch —
 * see pipeline.ts call order). Returns `undefined` when the file has never
 * been recorded (caller must not confuse "never seen" with "seen and clean";
 * an explicit `[]` from `recordDiagnostics` is a real empty array here).
 *
 * The `files` map key is normalized through `fileMapKey` (#1020), so any path
 * form of the same file — forward-slash, backslash, or a different Windows
 * drive-letter case — resolves to the same record. This read-side fold MUST
 * stay identical to the write-side fold, or a file recorded under one form
 * would silently read as `undefined` under another (e.g. via bus-publish).
 */
export function getFileDiagnostics(filePath: string): WidgetDiagnostic[] | undefined {
	const rec = files.get(fileMapKey(filePath));
	if (!rec) return undefined;
	return rec.allDiagnostics.map((d) => ({ ...d }));
}

/** @internal Test-only helpers. Do not use in production code. */
export const __testing = {
	getWidgetStateSnapshot(): {
		files: Array<{
			filePath: string;
			storedDiagnostics: number;
			blocking: number;
			errors: number;
			warnings: number;
		}>;
	} {
		return {
			files: [...files.values()].map((rec) => ({
				filePath: rec.filePath,
				storedDiagnostics: rec.diagnostics.length,
				blocking: rec.diagnosticCounts.blocking,
				errors: rec.diagnosticCounts.errors,
				warnings: rec.diagnosticCounts.warnings,
			})),
		};
	},
};

export function recordLsp(
	serverId: string,
	root: string,
	status: "spawn_start" | "spawn_success" | "spawn_failed" | "unavailable",
	durationMs?: number,
): void {
	const key = `${serverId}@${root}`;
	const mapped =
		status === "spawn_start"
			? "spawning"
			: status === "spawn_success"
				? "ready"
				: "failed";
	lspServers.set(key, { serverId, root, status: mapped, durationMs });
	requestRender();
}

// ── Render ────────────────────────────────────────────────────────────────────

const HORIZONTAL_MIN_WIDTH = 70;

export function renderWidget(
	width: number,
	theme: {
		fg: (color: string, s: string) => string;
	},
): string[] {
	const dim = (s: string) => theme.fg("dim", s);
	const red = (s: string) => theme.fg("error", s);
	const yellow = (s: string) => theme.fg("warning", s);
	const green = (s: string) => theme.fg("success", s);
	const cyan = (s: string) => theme.fg("accent", s);
	const w = Math.max(1, width || 80);
	const useHorizontal = w >= HORIZONTAL_MIN_WIDTH;

	if (files.size === 0 && lspServers.size === 0) return [];

	const lines: string[] = [];

	// Header — counts from deduplicated files only
	const deduped = dedupeByBasename([...files.values()]);
	const recencySorted = deduped.filter(shouldRenderFile).slice(0, 5);
	const langStr = sessionLanguages.slice(0, 6).join(" ");
	const totalBlocking = countBlockingIn(deduped);
	const totalErrors = countTotalIn("error", deduped);
	const totalWarnings = countTotalIn("warning", deduped);
	const hasPendingAnalysis = deduped.some(isPendingAnalysis);
	const errorChunk =
		totalErrors > 0
			? (totalBlocking > 0 ? red : yellow)(`●${totalErrors}E`)
			: "";
	const warningChunk = totalWarnings > 0 ? yellow(`!${totalWarnings}W`) : "";
	const summary = errorChunk
		? errorChunk + (warningChunk ? " " + warningChunk : "")
		: warningChunk
			? warningChunk
			: files.size > 0 && !hasPendingAnalysis
				? green("✓ clean")
				: "";

	// LSP spawning — folded into the header in horizontal mode, tail line otherwise
	const spawning = [...lspServers.values()].filter(
		(s) => s.status === "spawning",
	);
	const lspChip =
		useHorizontal && spawning.length > 0 ? "  " + dim("LSP↑") : "";

	const header = ` ${cyan("pi-lens")}${langStr ? "  " + dim(langStr) : ""}${lspChip}${summary ? "  " + summary : ""}`;
	lines.push(fitLine(header, w));

	// File list — display order varies by mode
	if (useHorizontal) {
		const displayOrder = sortByTierThenRecency(recencySorted);
		const rowLine = packHorizontalRow(displayOrder, w, theme);
		if (rowLine.length > 0) lines.push(rowLine);
	} else {
		for (const rec of recencySorted) {
			lines.push(fitLine(formatFileRowVertical(rec, theme), w));
		}
	}

	// Diagnostics — blocking only, from the most recently touched file that has them.
	// Vertical mode keeps the divider/filename context; horizontal already shows the
	// filename on the packed row above, so we drop the extra header noise there.
	const withBlocking = recencySorted.filter((r) =>
		r.diagnostics.some(isBlocking),
	);
	if (withBlocking.length > 0) {
		const rec = withBlocking[0];
		if (!useHorizontal) {
			lines.push(fitLine(dim("─".repeat(Math.min(w, 60))), w));
			lines.push(fitLine(` ${dim(path.basename(rec.filePath))}`, w));
		}
		const blockers = rec.diagnostics.filter(isBlocking).slice(0, 5);
		for (const d of blockers) {
			const loc = d.line != null ? osc8(d.uri ?? "", `L${d.line}`) : "";
			const rule = d.rule ? dim(` ${d.rule}`) : "";
			const prefix = `   ${red("●")} ${loc}${rule}  `;
			const msgWidth = Math.max(1, w - visibleWidth(prefix));
			const msg = fitLine(d.message, msgWidth, "…");
			lines.push(fitLine(`${prefix}${msg}`, w));
		}
	}

	// LSP status tail — only in vertical mode; horizontal folds into header
	if (!useHorizontal && spawning.length > 0) {
		const ids = spawning.map((s) => s.serverId).join(" ");
		lines.push(fitLine(` ${dim(`LSP spawning: ${ids}`)}`, w));
	}

	return lines;
}

// ── File row layout ──────────────────────────────────────────────────────────

type FileTier = "blocking" | "warning" | "clean";

function classifyFileTier(rec: FileRecord): FileTier {
	if (rec.diagnosticCounts.blocking > 0) return "blocking";
	if (rec.diagnosticCounts.errors > 0 || rec.diagnosticCounts.warnings > 0) {
		return "warning";
	}
	return "clean";
}

function sortByTierThenRecency(recs: FileRecord[]): FileRecord[] {
	const order: Record<FileTier, number> = {
		blocking: 0,
		warning: 1,
		clean: 2,
	};
	return [...recs].sort((a, b) => {
		const ta = order[classifyFileTier(a)];
		const tb = order[classifyFileTier(b)];
		if (ta !== tb) return ta - tb;
		return b.touchedAt - a.touchedAt;
	});
}

function formatFileRowVertical(
	rec: FileRecord,
	theme: { fg: (color: string, s: string) => string },
): string {
	const dim = (s: string) => theme.fg("dim", s);
	const red = (s: string) => theme.fg("error", s);
	const yellow = (s: string) => theme.fg("warning", s);
	const green = (s: string) => theme.fg("success", s);

	const base = path.basename(rec.filePath);
	const blocking = rec.diagnosticCounts.blocking;
	const errors = rec.diagnosticCounts.errors;
	const warnings = rec.diagnosticCounts.warnings;
	const dot =
		blocking > 0
			? red("●")
			: warnings > 0 || errors > 0
				? yellow("!")
				: green("✓");
	const runnerNames = [...rec.runners.entries()]
		.filter(([, r]) => r.status !== "skipped")
		.map(([id]) => id)
		.join(" ");
	const counts =
		errors > 0
			? " " +
				(blocking > 0 ? red : yellow)(`${errors}E`) +
				(warnings > 0 ? " " + yellow(`${warnings}W`) : "")
			: warnings > 0
				? " " + yellow(`${warnings}W`)
				: " " + dim("clean");
	const changedFormatters = [...rec.formatters.entries()]
		.filter(([, f]) => f.changed)
		.map(([name]) => name);
	const formatMark =
		changedFormatters.length > 0
			? dim(` fmt:${changedFormatters.join(",")}`)
			: "";
	return ` ${dot} ${base}  ${dim(runnerNames)}${formatMark}${counts}`;
}

function packHorizontalRow(
	recs: FileRecord[],
	totalWidth: number,
	theme: { fg: (color: string, s: string) => string },
): string {
	if (recs.length === 0) return "";
	const dim = (s: string) => theme.fg("dim", s);
	const indent = "   ";
	const sep = "  ";
	// Reserve worst-case overflow space upfront so the marker always fits.
	// " +NN" — 4 visible chars covers up to two-digit overflow.
	const overflowReserve = 4;
	let used = visibleWidth(indent);
	const parts: string[] = [indent];
	const addedTokenWidths: number[] = [];
	let droppedAt = -1;
	for (let i = 0; i < recs.length; i++) {
		const sepWidth = parts.length > 1 ? visibleWidth(sep) : 0;
		const willOverflow = i < recs.length - 1;
		const reserve = willOverflow ? overflowReserve : 0;
		const remaining = totalWidth - used - sepWidth - reserve;
		if (remaining < 4) {
			droppedAt = i;
			break;
		}
		const token = formatFileTokenHorizontal(recs[i], remaining, theme);
		const tokenWidth = visibleWidth(token);
		if (token.length === 0 || used + sepWidth + tokenWidth > totalWidth) {
			droppedAt = i;
			break;
		}
		if (sepWidth > 0) {
			parts.push(sep);
			used += sepWidth;
		}
		parts.push(token);
		used += tokenWidth;
		addedTokenWidths.push(tokenWidth + sepWidth);
	}
	if (droppedAt >= 0) {
		let dropped = recs.length - droppedAt;
		let overflow = " " + dim(`+${dropped}`);
		// If reservation was insufficient (e.g. last token grew because no
		// reserve was applied), shed accepted tokens until overflow fits.
		while (
			used + visibleWidth(overflow) > totalWidth &&
			addedTokenWidths.length > 0
		) {
			const lastWidth = addedTokenWidths.pop() as number;
			used -= lastWidth;
			parts.pop(); // token
			if (parts.length > 1) parts.pop(); // preceding separator
			dropped++;
			overflow = " " + dim(`+${dropped}`);
		}
		if (used + visibleWidth(overflow) <= totalWidth) {
			parts.push(overflow);
		}
	}
	return fitLine(parts.join(""), totalWidth);
}

function formatFileTokenHorizontal(
	rec: FileRecord,
	remainingWidth: number,
	theme: { fg: (color: string, s: string) => string },
): string {
	const dim = (s: string) => theme.fg("dim", s);
	const red = (s: string) => theme.fg("error", s);
	const yellow = (s: string) => theme.fg("warning", s);

	const blocking = rec.diagnosticCounts.blocking;
	const errors = rec.diagnosticCounts.errors;
	const warnings = rec.diagnosticCounts.warnings;
	const formatterChanged = hasChangedFormatter(rec);

	let dotChar: string;
	if (blocking > 0) dotChar = red("●");
	else if (errors > 0 || warnings > 0) dotChar = yellow("!");
	else if (formatterChanged) dotChar = dim("✎");
	else dotChar = dim("·");

	let countsStyled = "";
	if (errors > 0 && warnings > 0) {
		const eColor = blocking > 0 ? red : yellow;
		countsStyled = " " + eColor(`${errors}E`) + yellow(`${warnings}W`);
	} else if (errors > 0) {
		const eColor = blocking > 0 ? red : yellow;
		countsStyled = " " + eColor(`${errors}E`);
	} else if (warnings > 0) {
		countsStyled = " " + yellow(`${warnings}W`);
	}

	const fullBasename = path.basename(rec.filePath);
	const fixedWidth = visibleWidth(dotChar) + 1 + visibleWidth(countsStyled);
	const basenameBudget = remainingWidth - fixedWidth;
	if (basenameBudget < 3) return "";
	const truncated = truncateBasename(fullBasename, basenameBudget);
	const linked = osc8(pathToFileURL(rec.filePath).href, truncated);
	return `${dotChar} ${linked}${countsStyled}`;
}

function truncateBasename(name: string, maxWidth: number): string {
	if (visibleWidth(name) <= maxWidth) return name;
	if (maxWidth < 2) return "…";
	const ext = path.extname(name);
	const stem = name.slice(0, name.length - ext.length);
	const keep = maxWidth - ext.length - 1;
	if (keep < 1) {
		// Extension alone wouldn't fit; truncate the whole name.
		return name.slice(0, maxWidth - 1) + "…";
	}
	return stem.slice(0, keep) + "…" + ext;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getOrCreate(filePath: string): FileRecord {
	// Look up by the normalized key so mixed path forms of the same file share
	// ONE record (#1020); keep the caller's verbatim path as the display path.
	return (
		files.get(fileMapKey(filePath)) ?? {
			filePath,
			runners: new Map(),
			formatters: new Map(),
			diagnostics: [],
			allDiagnostics: [],
			diagnosticCounts: { blocking: 0, errors: 0, warnings: 0 },
			hasFinalDiagnosticsSnapshot: false,
			touchedAt: Date.now(),
		}
	);
}

function hasChangedFormatter(rec: FileRecord): boolean {
	return [...rec.formatters.values()].some((f) => f.changed);
}

function shouldRenderFile(rec: FileRecord): boolean {
	return rec.hasFinalDiagnosticsSnapshot || hasChangedFormatter(rec);
}

function isPendingAnalysis(rec: FileRecord): boolean {
	return rec.runners.size > 0 && !rec.hasFinalDiagnosticsSnapshot;
}

function capStoredDiagnostics(
	diagnostics: WidgetDiagnostic[],
): WidgetDiagnostic[] {
	if (diagnostics.length <= MAX_STORED_DIAGNOSTICS_PER_FILE) return diagnostics;
	const blockers = diagnostics.filter(isBlocking);
	if (blockers.length >= MAX_STORED_DIAGNOSTICS_PER_FILE) {
		return blockers.slice(0, MAX_STORED_DIAGNOSTICS_PER_FILE);
	}
	const rest = diagnostics.filter((d) => !isBlocking(d));
	return [
		...blockers,
		...rest.slice(0, MAX_STORED_DIAGNOSTICS_PER_FILE - blockers.length),
	];
}

function countTotalIn(
	severity: "error" | "warning",
	recs: FileRecord[],
): number {
	let n = 0;
	for (const rec of recs) {
		if (severity === "error") n += rec.diagnosticCounts.errors;
		else n += rec.diagnosticCounts.warnings;
	}
	return n;
}

function countBlockingIn(recs: FileRecord[]): number {
	let n = 0;
	for (const rec of recs) n += rec.diagnosticCounts.blocking;
	return n;
}

function requestRender(): void {
	requestRenderFn?.();
}

function osc8(uri: string, label: string): string {
	if (!uri) return label;
	return `\x1b]8;;${uri}\x1b\\${label}\x1b]8;;\x1b\\`;
}

// Dual-signature truncateToWidth handling lives in tui-fit.ts (shared with the
// turn-summary message renderer, which learned the hard way that pi-tui crashes
// the host on over-width lines — #513).

function dedupeByBasename(recs: FileRecord[]): FileRecord[] {
	const seen = new Map<string, FileRecord>();
	for (const r of [...recs].sort((a, b) => a.touchedAt - b.touchedAt)) {
		seen.set(path.basename(r.filePath), r);
	}
	return [...seen.values()].sort((a, b) => b.touchedAt - a.touchedAt);
}
