/**
 * Dependency Checker for pi-local
 *
 * Real-time circular dependency detection.
 * Caches the dependency graph and only re-scans when imports change.
 * Runs in the tool_result hook like ast-grep and Biome.
 *
 * Requires: npm install -D madge
 * Docs: https://github.com/pahen/madge
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { findNodeToolBinary } from "./package-manager.js";
import { safeSpawnAsync } from "./safe-spawn.js";

// --- Types ---

export interface CircularDep {
	file: string;
	path: string[]; // The cycle path
}

/**
 * Build madge's argv for a circular-dependency scan.
 *
 * Two correctness levers beyond the bare `--circular`:
 *   - `mjs,cjs` extensions: without them madge ignores explicit ESM/CJS files,
 *     dropping their edges from the graph.
 *   - `--ts-config <tsconfig.json>`: madge can only resolve TypeScript `paths`
 *     aliases (`@/foo`, `~/bar`) when pointed at the tsconfig. Without it those
 *     imports are silently unresolved, so cycles that route through an alias are
 *     MISSED (false negatives). Passed only when a tsconfig actually exists, so
 *     non-TS / alias-free projects are unaffected.
 */
export function buildMadgeArgs(target: string, projectRoot: string): string[] {
	const args = ["--circular", "--extensions", "ts,tsx,js,jsx,mjs,cjs"];
	const tsConfig = path.join(projectRoot, "tsconfig.json");
	if (fs.existsSync(tsConfig)) {
		args.push("--ts-config", tsConfig);
	}
	// --warning surfaces files madge couldn't resolve into the graph (to stderr;
	// stdout JSON is unaffected). Without it those skips are SILENT — and a
	// skipped *local* file could hide a real cycle. We log them (see
	// parseMadgeSkips) instead of discarding stderr.
	args.push("--warning", "--json", target);
	return args;
}

/**
 * Parse madge's `--warning` stderr for skipped (unresolvable) files. External
 * package specifiers (bare names / subpaths like `web-tree-sitter`,
 * `vitest/config`) are expected — madge doesn't traverse node_modules. We flag
 * only **local** skips (relative/absolute paths), which are the ones that could
 * silently drop an internal edge and hide a cycle.
 *
 * @returns total skip count and the subset that look local.
 */
export function parseMadgeSkips(stderr: string): {
	total: number;
	local: string[];
} {
	const lines = (stderr || "").split(/\r?\n/);
	const headerIdx = lines.findIndex((l) => /Skipped\s+\d+\s+file/i.test(l));
	if (headerIdx === -1) return { total: 0, local: [] };
	const total =
		Number.parseInt(lines[headerIdx].match(/Skipped\s+(\d+)/i)?.[1] ?? "0", 10) ||
		0;
	const specifiers = lines
		.slice(headerIdx + 1)
		.map((l) => l.trim())
		.filter(Boolean);
	const local = specifiers.filter(
		(s) => s.startsWith(".") || s.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(s),
	);
	return { total, local };
}

export interface DepCheckResult {
	hasCircular: boolean;
	circular: CircularDep[];
	checked: boolean;
	cacheHit: boolean;
	/** Count of LOCAL files madge skipped (couldn't resolve) — a potential
	 * silent cycle-miss. Undefined when not checked. */
	localSkips?: number;
}

// --- Graph Cache ---

interface FileImports {
	imports: Set<string>;
	timestamp: number;
	/**
	 * File byte size at cache time (#1105). The mtime fast-path below is a stale
	 * signal on its own: a content change that PRESERVES mtime (git checkout
	 * timestamp restoration, a formatter preserving mtime, a same-second write)
	 * would let `importsChanged` return false and skip the madge circular-dep
	 * re-check against edited imports. Size is free (the stat already ran) and is
	 * the review-graph gold-standard second axis — an import edit almost always
	 * changes byte length, so this closes the common case at zero I/O cost.
	 */
	size: number;
}

/**
 * Defensive cap on concurrent madge spawns for a single `checkFilesBatch`
 * call. A turn usually only touches 1-3 import-changed files, so this rarely
 * binds — it just guards against a pathological turn (bulk rename/move) from
 * fork-bombing subprocesses.
 */
const MADGE_BATCH_CONCURRENCY = 6;

/** Run `mapper` over `items` with at most `concurrency` in flight at once. */
async function mapWithConcurrency<T>(
	items: T[],
	concurrency: number,
	mapper: (item: T) => Promise<void>,
): Promise<void> {
	if (items.length === 0) return;
	let nextIndex = 0;
	const workerCount = Math.max(1, Math.min(concurrency, items.length));
	const workers = Array.from({ length: workerCount }, async () => {
		while (true) {
			const index = nextIndex++;
			if (index >= items.length) return;
			await mapper(items[index]);
		}
	});
	await Promise.all(workers);
}

// --- Client ---

export class DependencyChecker {
	private available: boolean | null = null;
	private ensureInFlight: Promise<boolean> | null = null;
	private checkInFlight = new Map<string, Promise<DepCheckResult>>();
	private scanInFlight = new Map<
		string,
		Promise<{ circular: CircularDep[]; count: number }>
	>();
	private log: (msg: string) => void;

	// Cache: file path -> its imports
	private importCache = new Map<string, FileImports>();

	// Circular deps: last known circular deps
	private lastCircular: CircularDep[] = [];

	// Files that are part of a circular dependency
	private circularFiles = new Set<string>();

	constructor(verbose = false) {
		this.log = verbose
			? (msg: string) => console.error(`[deps] ${msg}`)
			: () => {};
	}

	/**
	 * Resolve how to invoke madge for `cwd`: a local/global-installed binary
	 * (npm/pnpm/yarn/bun) if found, else `npx madge` (#375). `prefix` is prepended
	 * to the madge args (empty for a resolved binary, `["madge"]` for the npx
	 * fallback).
	 */
	private async resolveMadge(
		cwd: string,
	): Promise<{ cmd: string; prefix: string[] }> {
		const bin = await findNodeToolBinary("madge", cwd);
		return bin ? { cmd: bin, prefix: [] } : { cmd: "npx", prefix: ["madge"] };
	}

	/**
	 * Check if madge is available, auto-install if not
	 */
	async ensureAvailable(): Promise<boolean> {
		// Fast path: already checked
		if (this.available !== null) return this.available;
		if (this.ensureInFlight) return this.ensureInFlight;

		this.ensureInFlight = this.doEnsureAvailable();
		try {
			return await this.ensureInFlight;
		} finally {
			this.ensureInFlight = null;
		}
	}

	private async doEnsureAvailable(): Promise<boolean> {
		// Check if available in PATH
		const result = await safeSpawnAsync("madge", ["--version"], {
			timeout: 5000,
		});
		this.available = !result.error && result.status === 0;

		if (this.available) {
			this.log(`Madge found: ${result.stdout?.trim()}`);
			return true;
		}

		// Auto-install via pi-lens installer
		this.log("Madge not found, attempting auto-install...");
		const { ensureTool } = await import("./installer/index.js");
		const installedPath = await ensureTool("madge");

		if (installedPath) {
			this.log(`Madge auto-installed: ${installedPath}`);
			this.available = true;
			return true;
		}

		this.available = false;
		this.log("Madge auto-install failed");
		return false;
	}

	/**
	 * Check if a file is part of a circular dependency (from cache)
	 */
	isInCircular(filePath: string): boolean {
		const normalized = path.resolve(filePath);
		return this.circularFiles.has(normalized);
	}

	/**
	 * Get circular deps for a specific file
	 */
	getCircularForFile(filePath: string): string[] {
		const normalized = path.resolve(filePath);
		const deps: string[] = [];

		for (const dep of this.lastCircular) {
			if (dep.file === normalized || dep.path.includes(normalized)) {
				// Add the other files in the cycle
				for (const f of dep.path) {
					if (f !== normalized) {
						deps.push(path.relative(process.cwd(), f));
					}
				}
			}
		}

		return Array.from(new Set(deps));
	}

	/**
	 * Extract imports from a TypeScript/JavaScript file
	 */
	extractImports(filePath: string): Set<string> {
		const content = fs.readFileSync(filePath, "utf-8");
		const imports = new Set<string>();

		// Match import statements: import ... from '...'
		const importPattern =
			/(?:import|export)\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g;
		const requirePattern = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

		let match;
		while ((match = importPattern.exec(content)) !== null) {
			if (match[1].startsWith(".")) {
				imports.add(match[1]);
			}
		}

		while ((match = requirePattern.exec(content)) !== null) {
			if (match[1].startsWith(".")) {
				imports.add(match[1]);
			}
		}

		return imports;
	}

	/**
	 * Check if imports have changed for a file
	 */
	importsChanged(filePath: string): boolean {
		const normalized = path.resolve(filePath);

		if (!fs.existsSync(normalized)) {
			this.importCache.delete(normalized);
			return true;
		}

		const stat = fs.statSync(normalized);
		const cached = this.importCache.get(normalized);

		// Fast path: neither mtime NOR size moved (#1105 — size guards the
		// mtime-preserving content change that mtime alone would miss).
		if (cached && cached.timestamp >= stat.mtimeMs && cached.size === stat.size) {
			return false;
		}

		// Compare actual imports
		const newImports = this.extractImports(normalized);
		const hasChanged = !cached || !this.setsEqual(cached.imports, newImports);

		// Update cache
		this.importCache.set(normalized, {
			imports: newImports,
			timestamp: stat.mtimeMs,
			size: stat.size,
		});
		return hasChanged;
	}

	/**
	 * Check if two sets have the same elements
	 */
	private setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
		if (a.size !== b.size) return false;
		for (const item of a) {
			if (!b.has(item)) return false;
		}
		return true;
	}

	/**
	 * Quick circular dependency check using DFS on cached graph.
	 * Only re-runs full madge check when imports change.
	 */
	async checkFile(filePath: string, cwd?: string): Promise<DepCheckResult> {
		const normalized = path.resolve(filePath);

		// Return early for non-existent files without running availability check
		if (!fs.existsSync(normalized)) {
			return {
				hasCircular: false,
				circular: [],
				checked: false,
				cacheHit: false,
			};
		}

		const projectRoot = path.resolve(cwd || process.cwd());

		// Check if imports changed before probing/installing madge.
		const importsChanged = this.importsChanged(normalized);

		if (!importsChanged) {
			// Return cached result
			return {
				hasCircular: this.circularFiles.has(normalized),
				circular: this.lastCircular.filter(
					(d) => d.file === normalized || d.path.includes(normalized),
				),
				checked: true,
				cacheHit: true,
			};
		}

		if (!(await this.ensureAvailable())) {
			return {
				hasCircular: false,
				circular: [],
				checked: false,
				cacheHit: false,
			};
		}

		const key = `${projectRoot}:${normalized}`;
		const existing = this.checkInFlight.get(key);
		if (existing) return existing;

		const promise = this.runCheckFile(normalized, projectRoot).finally(() => {
			this.checkInFlight.delete(key);
		});
		this.checkInFlight.set(key, promise);
		return promise;
	}

	private async runCheckFile(
		normalized: string,
		projectRoot: string,
	): Promise<DepCheckResult> {
		const spawnResult = await this.runMadgeSpawn(normalized, projectRoot);
		if (!spawnResult.ok) {
			return {
				hasCircular: false,
				circular: [],
				checked: false,
				cacheHit: false,
			};
		}

		this.lastCircular = spawnResult.circular;
		this.circularFiles = spawnResult.circularFiles;

		return {
			hasCircular: spawnResult.circular.length > 0,
			circular: spawnResult.circular.filter(
				(d) => d.file === normalized || d.path.includes(normalized),
			),
			checked: true,
			cacheHit: false,
			localSkips: spawnResult.localSkips,
		};
	}

	/**
	 * Run madge on a single file and parse its cycle output. Pure: unlike
	 * `runCheckFile`, this does NOT mutate `lastCircular`/`circularFiles` — it
	 * hands the parsed result back so callers can apply the shared-state update
	 * themselves (`runCheckFile` does so immediately; `checkFilesBatch` defers
	 * it so concurrent spawns can't clobber each other's writes, see #766).
	 */
	private async runMadgeSpawn(
		normalized: string,
		projectRoot: string,
	): Promise<
		| {
				ok: true;
				circular: CircularDep[];
				circularFiles: Set<string>;
				localSkips: number;
		  }
		| { ok: false }
	> {
		this.log(
			`Imports changed for ${path.basename(normalized)}, checking dependencies...`,
		);

		// Run madge on the specific file (fast)
		try {
			const { cmd, prefix } = await this.resolveMadge(projectRoot);
			const result = await safeSpawnAsync(
				cmd,
				[...prefix, ...buildMadgeArgs(normalized, projectRoot)],
				{
					timeout: 15000,
					cwd: projectRoot,
				},
			);

			if (result.error) {
				this.log(`Check error: ${result.error.message}`);
				return { ok: false };
			}

			const output = result.stdout || "[]";
			const parsed = JSON.parse(output);

			// Madge --circular --json returns array of cycle arrays: [["a.ts", "b.ts"], ...]
			const cycles: string[][] = Array.isArray(parsed) ? parsed : [];
			const circular: CircularDep[] = [];
			const circularFiles = new Set<string>();

			for (const cycle of cycles) {
				const resolvedPaths = cycle.map((f: string) =>
					path.resolve(projectRoot, f),
				);
				for (const f of resolvedPaths) {
					circularFiles.add(f);
				}
				circular.push({
					file: resolvedPaths[0],
					path: resolvedPaths,
				});
			}

			const skips = parseMadgeSkips(result.stderr || "");
			if (skips.local.length > 0) {
				this.log(
					`madge skipped ${skips.local.length} local file(s) (possible silent cycle-miss): ${skips.local.slice(0, 5).join(", ")}`,
				);
			}

			return { ok: true, circular, circularFiles, localSkips: skips.local.length };
		} catch (err: any) {
			this.log(`Check error: ${err.message}`);
			return { ok: false };
		}
	}

	/** Build the cache-hit `DepCheckResult` for `normalized` from current shared state. */
	private buildCachedResult(normalized: string): DepCheckResult {
		return {
			hasCircular: this.circularFiles.has(normalized),
			circular: this.lastCircular.filter(
				(d) => d.file === normalized || d.path.includes(normalized),
			),
			checked: true,
			cacheHit: true,
		};
	}

	/**
	 * Batch-check multiple files for circular deps in one turn-end pass,
	 * running the madge subprocess spawns concurrently (bounded by
	 * `MADGE_BATCH_CONCURRENCY`) instead of one at a time (#766).
	 *
	 * Equivalence with the sequential `for…await checkFile(file)` loop it
	 * replaces:
	 *  - Classification (existence + `importsChanged`) runs synchronously in
	 *    original array order first — identical to what each sequential
	 *    `checkFile()` call would do, including the `importCache` side effect.
	 *  - Only the actual madge spawns for import-changed ("miss") files run
	 *    concurrently; each one's parsed result stays LOCAL (no shared-state
	 *    write) until every spawn has settled.
	 *  - The shared `lastCircular`/`circularFiles` state is then folded by
	 *    replaying the miss results in ORIGINAL array order (not completion
	 *    order), so the final state — and each cache-hit file's result, which
	 *    reads the state as of its position in the array — is byte-for-byte
	 *    what the sequential last-write-wins loop would have produced. No
	 *    concurrent write can clobber another's, because none are applied
	 *    until after `Promise.all` resolves.
	 */
	async checkFilesBatch(
		filePaths: string[],
		cwd?: string,
	): Promise<Map<string, DepCheckResult>> {
		const projectRoot = path.resolve(cwd || process.cwd());
		const results = new Map<string, DepCheckResult>();

		type Entry =
			| { kind: "missing"; file: string }
			| { kind: "hit"; file: string; normalized: string }
			| { kind: "miss"; file: string; normalized: string };

		const entries: Entry[] = [];
		for (const file of filePaths) {
			const normalized = path.resolve(projectRoot, file);
			if (!fs.existsSync(normalized)) {
				entries.push({ kind: "missing", file });
				continue;
			}
			entries.push(
				this.importsChanged(normalized)
					? { kind: "miss", file, normalized }
					: { kind: "hit", file, normalized },
			);
		}

		const missEntries = entries.filter(
			(e): e is Extract<Entry, { kind: "miss" }> => e.kind === "miss",
		);

		const notAvailableResult: DepCheckResult = {
			hasCircular: false,
			circular: [],
			checked: false,
			cacheHit: false,
		};

		if (missEntries.length > 0 && !(await this.ensureAvailable())) {
			// madge unavailable: mirrors checkFile()'s "not available" branch for
			// every miss; hits still read whatever shared state already exists.
			for (const entry of entries) {
				if (entry.kind === "hit") {
					results.set(entry.file, this.buildCachedResult(entry.normalized));
				} else {
					results.set(entry.file, notAvailableResult);
				}
			}
			return results;
		}

		// Run the concurrent (bounded) madge spawns for the miss set only. Each
		// result stays local — keyed by normalized path — until folded below.
		const spawnResults = new Map<
			string,
			Awaited<ReturnType<DependencyChecker["runMadgeSpawn"]>>
		>();
		await mapWithConcurrency(missEntries, MADGE_BATCH_CONCURRENCY, async (entry) => {
			spawnResults.set(
				entry.normalized,
				await this.runMadgeSpawn(entry.normalized, projectRoot),
			);
		});

		// Fold in original order: each miss overwrites the shared state exactly
		// as the sequential loop would, and each hit is resolved against the
		// state as folded up to (but not past) its own position.
		for (const entry of entries) {
			if (entry.kind === "missing") {
				results.set(entry.file, notAvailableResult);
				continue;
			}
			if (entry.kind === "hit") {
				results.set(entry.file, this.buildCachedResult(entry.normalized));
				continue;
			}
			const spawnResult = spawnResults.get(entry.normalized);
			if (!spawnResult || !spawnResult.ok) {
				results.set(entry.file, notAvailableResult);
				continue;
			}
			this.lastCircular = spawnResult.circular;
			this.circularFiles = spawnResult.circularFiles;
			results.set(entry.file, {
				hasCircular: spawnResult.circular.length > 0,
				circular: spawnResult.circular.filter(
					(d) =>
						d.file === entry.normalized || d.path.includes(entry.normalized),
				),
				checked: true,
				cacheHit: false,
				localSkips: spawnResult.localSkips,
			});
		}

		return results;
	}

	/**
	 * Format circular dependency warning for LLM
	 */
	formatWarning(filePath: string, deps: string[]): string {
		if (deps.length === 0) return "";

		const filename = path.basename(filePath);
		const depNames = deps.map((d) => path.basename(d));

		let output = `[Circular Deps] ${filename} is in a cycle:\n`;
		output += `  ${filename} ↔ ${depNames.join(", ")}\n`;
		output += `\n  Consider extracting shared code to a separate module.\n`;

		return output;
	}

	/**
	 * Full project scan (for /check-deps command)
	 */
	async scanProject(
		cwd?: string,
	): Promise<{ circular: CircularDep[]; count: number }> {
		const projectRoot = path.resolve(cwd || process.cwd());

		// Return early for non-existent or empty directories before probing/installing.
		if (!fs.existsSync(projectRoot)) {
			return { circular: [], count: 0 };
		}
		const entries = fs.readdirSync(projectRoot);
		const hasSourceFiles = entries.some(
			(e) => /\.(ts|tsx|js|jsx)$/.test(e) && !e.endsWith(".d.ts"),
		);
		if (!hasSourceFiles) {
			return { circular: [], count: 0 };
		}

		if (!(await this.ensureAvailable())) {
			return { circular: [], count: 0 };
		}

		const existing = this.scanInFlight.get(projectRoot);
		if (existing) return existing;

		const promise = this.runScanProject(projectRoot).finally(() => {
			this.scanInFlight.delete(projectRoot);
		});
		this.scanInFlight.set(projectRoot, promise);
		return promise;
	}

	private async runScanProject(
		projectRoot: string,
	): Promise<{ circular: CircularDep[]; count: number }> {
		try {
			const { cmd, prefix } = await this.resolveMadge(projectRoot);
			const result = await safeSpawnAsync(
				cmd,
				[...prefix, ...buildMadgeArgs(projectRoot, projectRoot)],
				{
					timeout: 30000,
					cwd: projectRoot,
				},
			);

			if (result.error) {
				this.log(`Scan error: ${result.error.message}`);
				return { circular: [], count: 0 };
			}

			const output = result.stdout || "{}";
			const data = JSON.parse(output);

			const circular: CircularDep[] = [];
			const circularFiles = new Set<string>();

			for (const [file, deps] of Object.entries(data)) {
				if (Array.isArray(deps) && deps.length > 0) {
					const resolvedFile = path.resolve(file);
					circularFiles.add(resolvedFile);

					circular.push({
						file: resolvedFile,
						path: [resolvedFile, ...deps.map((d: string) => path.resolve(d))],
					});
				}
			}

			this.lastCircular = circular;
			this.circularFiles = circularFiles;

			return { circular, count: circular.length };
		} catch (err: any) {
			this.log(`Scan error: ${err.message}`);
			return { circular: [], count: 0 };
		}
	}

	/**
	 * Format full scan results
	 */
	formatScanResult(circular: CircularDep[]): string {
		if (circular.length === 0) return "";

		// Group by cycle to avoid duplicate entries
		const seen = new Set<string>();
		let output = `[Circular Deps] ${circular.length} cycle(s) found:\n`;

		for (const dep of circular) {
			const cycleKey = dep.path.sort((a, b) => a.localeCompare(b)).join("→");
			if (seen.has(cycleKey)) continue;
			seen.add(cycleKey);

			const names = dep.path.map((p) => path.relative(process.cwd(), p));
			output += `  • ${names.join(" → ")}\n`;
		}

		output += "\n  Consider extracting shared code to break cycles.\n";

		return output;
	}
}
