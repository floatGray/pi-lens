/**
 * Path utilities for pi-lens
 *
 * Handles cross-platform path normalization, particularly
 * Windows case-insensitivity issues when using paths as Map keys.
 *
 * Approach (inspired by OpenCode's Filesystem.normalizePath):
 * - On Windows: try realpathSync.native() for canonical casing
 * - Falls back to lowercase for files that don't exist yet
 * - On non-Windows: return path as-is (case-sensitive filesystem)
 * - Always convert backslashes to forward slashes for Map key consistency
 */

import { type Dirent, existsSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { minimatch } from "./deps/minimatch.js";

/**
 * Detect if a path is a Windows path (has drive letter or UNC prefix), by
 * SHAPE — true for a drive-letter/UNC-looking string regardless of the
 * running OS. Exported (refs #1152) so shape-aware callers outside this
 * module (e.g. `file-role.ts`'s `detectFileRole`) can branch to
 * `path.win32.dirname`/`basename` for a Windows-shaped path even when
 * `process.platform !== "win32"`, instead of the platform-default
 * `dirname`/`basename` silently misparsing it (the #1150 class).
 */
export function isWindowsPath(filePath: string): boolean {
	return /^[A-Za-z]:/.test(filePath) || filePath.startsWith("\\\\");
}

/**
 * Normalize a file path for consistent Map key usage.
 *
 * On Windows:
 * - If the file exists: uses realpathSync.native() to get the canonical
 *   filesystem path (actual casing, resolved symlinks)
 * - If the file doesn't exist: resolves the path and lowercases
 *   (needed for new files where we haven't written yet)
 *
 * On non-Windows: returns path as-is (case-sensitive filesystem).
 *
 * Always converts backslashes to forward slashes for consistent Map keys.
 */
export function normalizeFilePath(filePath: string): string {
	// Convert backslashes to forward slashes first
	const normalized = filePath.replace(/\\/g, "/");

	if (process.platform !== "win32" && !isWindowsPath(normalized)) {
		return normalized;
	}

	// Windows: try realpathSync.native() for canonical casing
	// This resolves symlinks and returns the actual filesystem casing
	try {
		const canonical = realpathSync.native(filePath);
		return canonical.replace(/\\/g, "/");
	} catch {
		// File doesn't exist yet (new file) — resolve path and lowercase
		// We need to walk up the directory tree to find the nearest existing
		// parent, resolve its casing, then append the non-existent parts
		try {
			return resolveNonExisting(filePath);
		} catch {
			// Last resort: just lowercase the resolved path
			const resolved = win32.normalize(win32.resolve(filePath));
			return resolved.replace(/\\/g, "/").toLowerCase();
		}
	}
}

/**
 * Resolve a non-existing path by finding the nearest existing parent,
 * getting its canonical casing, then appending the non-existent parts lowercased.
 *
 * Example: C:\Users\Foo\newdir\file.ts
 * - C:\Users\Foo exists → realpathSync gives C:\Users\Foo
 * - newdir\file.ts doesn't exist → lowercased
 * - Result: C:/Users/Foo/newdir/file.ts
 */
function resolveNonExisting(filePath: string): string {
	const resolved = win32.resolve(filePath);
	let current = resolved;
	const nonExistentParts: string[] = [];

	// Walk up until we find an existing directory
	while (true) {
		if (existsSync(current)) {
			// Found existing ancestor — get its canonical casing
			const canonical = realpathSync.native(current);
			if (nonExistentParts.length === 0) {
				return canonical.replace(/\\/g, "/");
			}
			// Append non-existent parts (lowercased for consistency)
			const tail = nonExistentParts.reverse().join("/").toLowerCase();
			const base = canonical.replace(/\\/g, "/");
			return base.endsWith("/") ? base + tail : `${base}/${tail}`;
		}

		// Use win32.dirname (not the platform-default dirname) so a
		// Windows-shaped path is parsed with win32 semantics regardless of the
		// running OS — consistent with the win32.resolve/win32.normalize this
		// branch already commits to. The platform-default POSIX dirname would
		// find no separator in a win32-resolved "C:\repo\..." path (its only
		// separators are backslashes), collapse to ".", stop the upward walk at
		// cwd, and mangle the key on Linux CI (refs #1150, the #1024
		// OS-divergence class).
		const parent = win32.dirname(current);
		if (parent === current) {
			// Reached filesystem root without finding existing dir
			// Fall back to full lowercase
			throw new Error("No existing parent found");
		}

		nonExistentParts.push(win32.basename(current));
		current = parent;
	}
}

/**
 * Convert a file:// URI to a normalized path.
 * Handles URL decoding and Windows drive letter normalization.
 */
export function uriToPath(uri: string): string {
	try {
		const filePath = fileURLToPath(uri);
		return normalizeFilePath(filePath);
	} catch {
		// Not a valid file:// URI, treat as plain path
		return normalizeFilePath(uri);
	}
}

/**
 * Decode a file:// URI to an on-disk path WITHOUT map-key normalization.
 *
 * `uriToPath` runs its result through `normalizeFilePath`, which on win32
 * lowercases the nonexistent tail of a path (see `resolveNonExisting`) and
 * canonicalizes an existing path to its real casing. That is correct for Map
 * keys, but DESTRUCTIVE for a real create/rename target: creating `NewFile.txt`
 * would write `newfile.txt`, and a legitimate case-only rename would collapse
 * to a no-op ("source and destination must differ"). Disk mutations must honor
 * the caller's intended casing, so they resolve their target through this
 * decode-only path while confinement/validation keep using the normalized
 * `uriToPath`. Non-win32 is unaffected either way (normalizeFilePath is a
 * near-identity there).
 */
export function uriToDiskPath(uri: string): string {
	try {
		return fileURLToPath(uri);
	} catch {
		// Not a valid file:// URI — treat as a plain path (matches uriToPath).
		return uri;
	}
}

/**
 * Convert a path to a file:// URI.
 * Does NOT normalize the path - URIs preserve original casing.
 */
export function pathToUri(filePath: string): string {
	return pathToFileURL(filePath).href;
}

/**
 * Normalize a Map key lookup for file paths.
 * Use this when getting/setting values in Maps that use file paths as keys.
 */
export function normalizeMapKey(filePath: string): string {
	return normalizeFilePath(filePath);
}

/**
 * Human-facing path relative to a project root when the file is inside it.
 *
 * Parses by path SHAPE, not host OS (refs #1150/#1152, shape-2 class #1163):
 * a Windows-shaped `filePath` (drive-letter/UNC — e.g. a persisted call-graph
 * symbol-key path `C:\repo\src\x.ts` rehydrated on a Linux CI run) is split
 * with `win32.*` regardless of `process.platform`. The host-default
 * `isAbsolute`/`relative` find no drive-letter anchor in a win32 path on POSIX:
 * `path.isAbsolute("C:\\repo\\x.ts")` returns FALSE on Linux, short-circuiting
 * to the raw absolute path instead of ever relativizing it — so a file that IS
 * under the project root renders as a full absolute path on Linux but the
 * expected `src/x.ts` on Windows (green-locally / wrong-on-CI, the #1024
 * divergence class). `win32.*` on a native POSIX path (Windows never sees one;
 * Linux native paths aren't Windows-shaped) is never selected, so same-OS
 * native paths are unchanged either way.
 */
export function toProjectRelativePath(filePath: string, projectRoot: string): string {
	const p = isWindowsPath(filePath) ? win32 : path;
	if (!p.isAbsolute(filePath)) return filePath.replace(/\\/g, "/");
	const relative = p.relative(p.resolve(projectRoot), filePath);
	return relative && !relative.startsWith("..") && !p.isAbsolute(relative)
		? relative.replace(/\\/g, "/")
		: filePath.replace(/\\/g, "/");
}

/**
 * Cheap, syntactic-only Map key normalization: slash-fold + (on Windows)
 * lowercase. No `realpathSync` / filesystem I/O.
 *
 * `normalizeMapKey` (via `normalizeFilePath`) calls `realpathSync.native()` to
 * get canonical on-disk casing — correct for maps that key long-lived state
 * shared across call sites (e.g. LSP/read-guard caches), but expensive when
 * the *point* of the cache is to avoid filesystem calls in the first place:
 * for a candidate path that does NOT exist (the common case for sibling-probe
 * memos), `normalizeFilePath` walks up the directory tree doing its own
 * `existsSync` calls to resolve the nearest existing ancestor — measured at
 * ~11x slower than the single `existsSync` probe such a cache is trying to
 * save (refs #191).
 *
 * Safe to use ONLY for ephemeral, single-process, single-walk caches whose
 * keys are produced by this process's own `path.join`/`path.resolve` calls
 * within the same run (so separators and casing are already consistent
 * modulo simple slash direction) — never for state shared across processes,
 * persisted, or compared against externally-supplied paths where symlink /
 * real-casing resolution actually matters.
 */
export function normalizeEphemeralMapKey(filePath: string): string {
	const slashed = filePath.replace(/\\/g, "/");
	return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}

/**
 * Compare two file paths for equality, handling Windows case-insensitivity
 * and mixed separators (backslash vs forward slash).
 */
export function pathsEqual(a: string, b: string): boolean {
	return normalizeFilePath(a) === normalizeFilePath(b);
}

/**
 * Check if `child` is under `parent` directory.
 * Separator-agnostic and case-insensitive on Windows.
 */
/**
 * Yield each directory from `startDir` up to (and including) the filesystem
 * root. Terminates when `path.dirname(current) === current` so it works on
 * Windows drive roots and POSIX `/` alike.
 *
 * Single source of truth for the half-dozen "walk up the directory tree
 * looking for X" loops that have accumulated across the codebase. Callers
 * that need an "is there a file named Y anywhere on the way up" check
 * should use `findNearestContaining` instead.
 */
export function* walkUpDirs(startDir: string): Generator<string> {
	let current = path.resolve(startDir);
	while (true) {
		yield current;
		const parent = path.dirname(current);
		if (parent === current) return;
		current = parent;
	}
}

/**
 * Walk up from `startDir` and return the first directory that contains any
 * of `candidates` on disk. Returns `undefined` if none match.
 *
 * @example
 *   findNearestContaining("/repo/pkg/src", ["package.json", "tsconfig.json"]);
 *   // → "/repo/pkg" if pkg/package.json exists, "/repo" if only /repo/package.json
 */
export function findNearestContaining(
	startDir: string,
	candidates: readonly string[],
): string | undefined {
	for (const dir of walkUpDirs(startDir)) {
		for (const name of candidates) {
			if (existsSync(path.join(dir, name))) return dir;
		}
	}
	return undefined;
}

/**
 * Walk up from `startDir` and return the first matching FILE path (not just
 * the containing directory) for any of `names`, first-match-wins within each
 * directory in `names` order. Single source of truth for the "walk up
 * looking for one of these config filenames" loop that `opengrep-config.ts`,
 * `typos-config.ts`, `zizmor-config.ts`, and `sgconfig.ts` each hand-rolled
 * independently (refs #680).
 *
 * Distinct from `findNearestContaining`, which returns the containing
 * directory rather than the matched file path — use that one when the caller
 * only needs "is one of these present nearby", not which file it is.
 *
 * @example
 *   findLocalToolConfig(cwd, ["typos.toml", "_typos.toml", ".typos.toml"]);
 *   // → "/repo/typos.toml" if present, else undefined
 */
export function findLocalToolConfig(
	startDir: string,
	names: readonly string[],
): string | undefined {
	for (const dir of walkUpDirs(startDir || process.cwd())) {
		for (const name of names) {
			const candidate = path.join(dir, name);
			if (existsSync(candidate)) return candidate;
		}
	}
	return undefined;
}

export interface FindNearestMarkerRootOptions {
	/**
	 * Directory names/files that, if found BEFORE any of `markers`, stop the
	 * walk and make it return `null` — e.g. `.git`/`.hg`/`.svn` so a search
	 * starting inside a repo without its own project marker doesn't escape
	 * past that repo's VCS boundary to pick up an unrelated parent's marker.
	 * Omit for callers with no such boundary (default: none).
	 */
	boundaries?: readonly string[];
	/** Override for `os.homedir()`, primarily for tests. */
	homeDir?: string;
}

/**
 * Walk up from `startDir` looking for a directory containing any of
 * `markers`, the same containment-aware climb `knip-client.ts` and
 * `dead-code-client.ts` each used to hand-roll independently (refs #625):
 *
 *   - Never resolves at or above `$HOME` (via `isAtOrAboveHomeDir`) — a
 *     marker found there has escaped the user's workspace.
 *   - If `options.boundaries` is given and one is found before any `marker`,
 *     stops and returns `null` rather than continuing past it.
 *   - Depth-capped at 64 climbs, matching the callers' existing safety bound
 *     (guards a pathological symlink loop; real depths are ~10).
 *   - Returns `null` — never `startDir` — when nothing is found. Callers
 *     must treat `null` as "no project here", not fall back to the start
 *     directory (a `null`-swallowing fallback was the #250/#296 bug class:
 *     scanning $HOME wholesale from a bare cwd).
 *
 * For a plain "find nearest containing directory" with no boundary concept,
 * use `findNearestContaining` instead. Distinct from `startup-scan.ts`'s
 * `findNearestProjectRoot` (fixed marker list, no boundaries, no home-check —
 * that caller applies `isAtOrAboveHomeDir` itself afterward); named
 * differently here to avoid confusion between the two.
 */
export function findNearestMarkerRoot(
	startDir: string,
	markers: readonly string[],
	options: FindNearestMarkerRootOptions = {},
): string | null {
	const boundaries = options.boundaries ?? [];
	const homeDir = path.resolve(options.homeDir ?? os.homedir());
	let current = path.resolve(startDir);
	for (let depth = 0; depth < 64; depth++) {
		if (isAtOrAboveHomeDir(current, homeDir)) return null;
		if (markers.some((m) => existsSync(path.join(current, m)))) return current;
		if (boundaries.some((m) => existsSync(path.join(current, m)))) return null;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
	return null;
}

/**
 * True when `dir` is the home directory OR an ancestor of it (`/home`,
 * `C:\Users`, the filesystem root, …). A project-root search that climbs to
 * such a directory has escaped the user's workspace — walking down from it
 * scans unrelated trees (the #250 runaway). Use this as the single shared
 * ceiling on any upward project-root resolution, instead of an exact
 * `=== os.homedir()` check (which a marker found *above* `$HOME` slips past).
 * A normal project *under* home (e.g. `~/code/app`) is NOT at-or-above home,
 * so it still resolves fine. Refs #253.
 */
export function isAtOrAboveHomeDir(
	dir: string,
	homeDir: string = os.homedir(),
): boolean {
	const resolvedDir = path.resolve(dir);
	const resolvedHome = path.resolve(homeDir);
	if (resolvedDir === resolvedHome) return true;
	// `dir` is an ancestor of home ⇢ home lies inside dir ⇢ the relative path
	// from dir to home has no leading `..` and is not absolute (cross-drive on
	// Windows yields an absolute rel, correctly treated as "not above").
	const rel = path.relative(resolvedDir, resolvedHome);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function isUnderDir(child: string, parent: string): boolean {
	const normChild = normalizeFilePath(child);
	const normParent = normalizeFilePath(parent);
	// Ensure parent ends with / for prefix matching
	const parentPrefix = normParent.endsWith("/") ? normParent : `${normParent}/`;
	return normChild === normParent || normChild.startsWith(parentPrefix);
}

const VENDOR_DIR_NAMES = new Set([
	"node_modules",
	"vendor",
	"vendors",
	"third_party",
	"third-party",
]);

/**
 * Returns true when a file should be treated as external/vendor and excluded
 * from pipelines (LSP, diagnostics, complexity, read-guard, etc.).
 *
 * Cases:
 *   1. Outside the project root entirely (e.g. global npm packages, system files)
 *   2. Inside the project but under a vendor directory (node_modules, vendor, third_party, etc.)
 */
export function isExternalOrVendorFile(
	filePath: string,
	projectRoot: string,
): boolean {
	if (!isUnderDir(filePath, projectRoot)) return true;
	const normalized = normalizeFilePath(filePath);
	const rootNorm = normalizeFilePath(projectRoot);
	const rel = normalized.startsWith(rootNorm + "/")
		? normalized.slice(rootNorm.length + 1)
		: normalized;
	return rel.split("/").some((seg) => VENDOR_DIR_NAMES.has(seg));
}

/**
 * Shared marker-glob semantics for every "does this directory contain a file
 * matching this glob" probe (#895 review): match against the entry NAME only,
 * `dot: true` so dotfile markers match, `nocase` on win32 to match the
 * filesystem (and the project ignore matcher). The three marker probes —
 * language-profile.ts `hasProjectMarker`, workspace-topology.ts
 * `hasBasenameMarker`, lsp/server.ts `markerExists` — must all route their
 * glob matching through here rather than call minimatch with hand-copied
 * options.
 */
export function nameMatchesMarkerGlob(name: string, pattern: string): boolean {
	return minimatch(name, pattern, {
		dot: true,
		nocase: process.platform === "win32",
	});
}

/**
 * Files/symlinks-only marker-glob probe over a directory listing — a
 * *directory* named like a marker (e.g. a `Foo.csproj/` dir) is not a project
 * file (#201).
 */
export function direntsHaveMarkerGlobMatch(
	entries: readonly Dirent[],
	pattern: string,
): boolean {
	return entries.some(
		(entry) =>
			(entry.isFile() || entry.isSymbolicLink()) &&
			nameMatchesMarkerGlob(entry.name, pattern),
	);
}
