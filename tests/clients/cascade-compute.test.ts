import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ImpactCascadeResult,
	ReviewGraph,
} from "../../clients/review-graph/types.js";
import { setupTestEnvironment } from "./test-utils.js";

type ImpactHitMock = {
	symbol: string;
	file: string;
	depth: number;
	relation: string;
};

const mocks = vi.hoisted(() => ({
	buildOrUpdateGraph: vi.fn(),
	computeImpactCascade: vi.fn(),
	computeTransitiveImpact: vi.fn(
		(): {
			seedFile: string;
			hits: ImpactHitMock[];
			truncated: boolean;
			maxDepthReached: number;
		} => ({ seedFile: "", hits: [], truncated: false, maxDepthReached: 0 }),
	),
	formatImpactCascade: vi.fn(),
	getLSPService: vi.fn(),
	// #1104: logCascade no-ops under isTestMode(), so the only way to assert on
	// its call shape (e.g. the neighbor_touch `inconclusive` metadata flag) is to
	// spy on it directly rather than reading cascade.log.
	logCascade: vi.fn(),
}));

vi.mock("../../clients/review-graph/service.js", () => ({
	buildOrUpdateGraph: mocks.buildOrUpdateGraph,
	computeImpactCascade: mocks.computeImpactCascade,
	computeTransitiveImpact: mocks.computeTransitiveImpact,
	formatImpactCascade: mocks.formatImpactCascade,
}));

vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: mocks.getLSPService,
}));

vi.mock("../../clients/cascade-logger.js", () => ({
	logCascade: mocks.logCascade,
	flushCascadeLog: vi.fn().mockResolvedValue(undefined),
	getCascadeLogPath: vi.fn().mockReturnValue("/tmp/cascade.log"),
}));

const lspError = (message = "cascade error") => ({
	severity: 1 as const,
	message,
	range: {
		start: { line: 2, character: 4 },
		end: { line: 2, character: 10 },
	},
	code: "X1",
	source: "test-lsp",
});

// #1095: attach a content `binding` the way the REAL producers do — a
// NON-enumerable property (getAllDiagnostics uses a lazy getter, touchFile a
// value; both non-enumerable). Mirroring non-enumerability also guards against a
// future regression where the cascade reads `.binding` off a spread/clone (which
// silently drops it). `undefined` means no binding attached at all — the honest
// pre-#1095 fall-through, identical to "unknown" at every call site.
function withBinding<T extends object>(
	obj: T,
	boundToCurrentDisk: boolean | "unknown",
): T {
	Object.defineProperty(obj, "binding", {
		value: { boundToCurrentDisk },
		enumerable: false,
		configurable: true,
	});
	return obj;
}

function emptyGraph(): ReviewGraph {
	return {
		version: "test",
		builtAt: new Date().toISOString(),
		nodes: new Map(),
		edges: [],
		edgesByFrom: new Map(),
		edgesByTo: new Map(),
		fileNodes: new Map(),
		symbolNodesByFile: new Map(),
		changedSymbolsByFile: new Map(),
	};
}

function impact(filePath: string, neighbors: string[]): ImpactCascadeResult {
	return {
		filePath,
		changedSymbols: ["changed"],
		directImporters: neighbors,
		directCallers: [],
		neighborFiles: neighbors,
		riskFlags: [],
	};
}

describe("computeCascadeForFile", () => {
	// vi.resetModules() drops the whole module cache and the dynamic re-import
	// below pays a full cold-resolve; under full-suite parallel CPU contention
	// that setup can exceed the default 10s hook timeout (it passes comfortably
	// in isolation). Raise the hook budget — this is setup, not an assertion, so
	// a longer ceiling absorbs the contention without masking a product failure.
	beforeEach(async () => {
		vi.resetModules();
		mocks.buildOrUpdateGraph.mockReset().mockResolvedValue(emptyGraph());
		mocks.computeImpactCascade.mockReset();
		mocks.computeTransitiveImpact.mockReset().mockReturnValue({
			seedFile: "",
			hits: [],
			truncated: false,
			maxDepthReached: 0,
		});
		mocks.formatImpactCascade.mockReset().mockReturnValue("impact header");
		mocks.getLSPService.mockReset();
		mocks.logCascade.mockReset();
		const { resetDispatchBaselines } = await import(
			"../../clients/dispatch/integration.js"
		);
		resetDispatchBaselines();
	}, 30_000);

	it("reads jsts neighbors from passive snapshot instead of active touching", async () => {
		const env = setupTestEnvironment("cascade-jsts-");
		try {
			const primary = path.join(env.tmpDir, "src", "primary.ts");
			const neighbor = path.join(env.tmpDir, "src", "neighbor.ts");
			fs.mkdirSync(path.dirname(primary), { recursive: true });
			fs.writeFileSync(primary, "export const x = 1;\n");
			fs.writeFileSync(neighbor, "import { x } from './primary';\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
			const touchFile = vi.fn();
			mocks.getLSPService.mockReturnValue({
				getAllDiagnostics: vi
					.fn()
					.mockResolvedValue(
						new Map([
							[
								neighbor.split(path.sep).join("/"),
								{ diags: [lspError()], ts: Date.now() },
							],
						]),
					),
				touchFile,
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			const result = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			expect(touchFile).not.toHaveBeenCalled();
			expect(result?.result?.neighbors[0]?.diagnostics[0]?.filePath).toBe(
				neighbor,
			);
			expect(result?.result?.formatted).toContain("neighbor.ts");
		} finally {
			env.cleanup();
		}
	});

	it("includes bounded transitive (depth>1) dependents as neighbors", async () => {
		const env = setupTestEnvironment("cascade-transitive-");
		try {
			const primary = path.join(env.tmpDir, "src", "primary.ts");
			const direct = path.join(env.tmpDir, "src", "direct.ts");
			const indirect = path.join(env.tmpDir, "src", "indirect.ts");
			fs.mkdirSync(path.dirname(primary), { recursive: true });
			fs.writeFileSync(primary, "export const x = 1;\n");
			fs.writeFileSync(direct, "import { x } from './primary';\n");
			fs.writeFileSync(indirect, "import './direct';\n");
			// One-hop cascade sees only the direct importer…
			mocks.computeImpactCascade.mockReturnValue(impact(primary, [direct]));
			// …while the transitive walk also reaches the depth-2 dependent.
			mocks.computeTransitiveImpact.mockReturnValue({
				seedFile: primary,
				hits: [
					{ symbol: "", file: direct, depth: 1, relation: "imports" },
					{ symbol: "", file: indirect, depth: 2, relation: "imports" },
				],
				truncated: false,
				maxDepthReached: 2,
			});
			mocks.getLSPService.mockReturnValue({
				getAllDiagnostics: vi.fn().mockResolvedValue(
					new Map([
						[
							direct.split(path.sep).join("/"),
							{ diags: [lspError("d")], ts: Date.now() },
						],
						[
							indirect.split(path.sep).join("/"),
							{ diags: [lspError("i")], ts: Date.now() },
						],
					]),
				),
				touchFile: vi.fn(),
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			const result = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});
			const neighborFiles = result?.result?.neighbors.map(
				(n) => n.diagnostics[0]?.filePath,
			);
			expect(neighborFiles).toContain(indirect); // depth-2 dependent surfaced
		} finally {
			env.cleanup();
		}
	});

	it("adds LSP reference files for changed-symbol blast radius", async () => {
		const env = setupTestEnvironment("cascade-lsp-refs-");
		try {
			const primary = path.join(env.tmpDir, "src", "primary.ts");
			const reference = path.join(env.tmpDir, "src", "consumer.ts");
			fs.mkdirSync(path.dirname(primary), { recursive: true });
			fs.writeFileSync(primary, "export function changed() { return 1; }\n");
			fs.writeFileSync(
				reference,
				"import { changed } from './primary';\nchanged();\n",
			);

			const graph = emptyGraph();
			const normalizedPrimary = primary.split(path.sep).join("/");
			const symbolId = `${normalizedPrimary}:changed`;
			graph.symbolNodesByFile.set(normalizedPrimary, [symbolId]);
			graph.nodes.set(symbolId, {
				id: symbolId,
				kind: "symbol",
				language: "jsts",
				filePath: normalizedPrimary,
				symbolName: "changed",
				symbolKind: "function",
				metadata: { line: 1, column: 17 },
			});
			mocks.buildOrUpdateGraph.mockResolvedValue(graph);
			mocks.computeImpactCascade.mockReturnValue({
				...impact(primary, []),
				changedSymbols: ["changed"],
			});
			const references = vi.fn().mockResolvedValue([
				{
					uri: pathToFileURL(reference).href,
					range: {
						start: { line: 1, character: 0 },
						end: { line: 1, character: 7 },
					},
				},
			]);
			mocks.getLSPService.mockReturnValue({
				getAllDiagnostics: vi
					.fn()
					.mockResolvedValue(
						new Map([
							[
								reference.split(path.sep).join("/"),
								{ diags: [lspError("reference broken")], ts: Date.now() },
							],
						]),
					),
				touchFile: vi.fn(),
				getDiagnostics: vi.fn(),
				references,
			});

			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			const result = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			expect(references).toHaveBeenCalledWith(normalizedPrimary, 0, 16, false);
			expect(
				result?.result?.neighbors.some(
					(n) =>
						n.filePath.split(path.sep).join("/") ===
						reference.split(path.sep).join("/"),
				),
			).toBe(true);
			expect(result?.result?.formatted).toContain("consumer.ts");
		} finally {
			env.cleanup();
		}
	});

	// #1109: the LSP-references blast-radius upgrade races `references()`
	// against a 750ms setTimeout. When `references()` wins (the common case —
	// the mocked LSP resolves synchronously), the losing setTimeout must be
	// cleared. Pre-fix, the handle was never stored, so the timer stayed a
	// REF'D pending timer for the remaining budget — a same-shape sibling of
	// the #1097 LSP client-wait leak (a one-shot `pi --print` process would
	// stay alive up to 750ms per changed symbol after the run settled).
	//
	// Uses fake timers (vi.getTimerCount, matching
	// tests/clients/lsp/client-wait-timer-cleanup.test.ts's pattern) so a
	// leaked timer is provable rather than merely "fires after the test ends."
	it("clears the LSP-references race timer once references() wins (#1109)", async () => {
		vi.useFakeTimers();
		const env = setupTestEnvironment("cascade-lsp-refs-timer-");
		try {
			const primary = path.join(env.tmpDir, "src", "primary.ts");
			const reference = path.join(env.tmpDir, "src", "consumer.ts");
			fs.mkdirSync(path.dirname(primary), { recursive: true });
			fs.writeFileSync(primary, "export function changed() { return 1; }\n");
			fs.writeFileSync(
				reference,
				"import { changed } from './primary';\nchanged();\n",
			);

			const graph = emptyGraph();
			const normalizedPrimary = primary.split(path.sep).join("/");
			const symbolId = `${normalizedPrimary}:changed`;
			graph.symbolNodesByFile.set(normalizedPrimary, [symbolId]);
			graph.nodes.set(symbolId, {
				id: symbolId,
				kind: "symbol",
				language: "jsts",
				filePath: normalizedPrimary,
				symbolName: "changed",
				symbolKind: "function",
				metadata: { line: 1, column: 17 },
			});
			mocks.buildOrUpdateGraph.mockResolvedValue(graph);
			mocks.computeImpactCascade.mockReturnValue({
				...impact(primary, []),
				changedSymbols: ["changed"],
			});
			// Resolves via a microtask — fake timers don't block microtask
			// resolution, only the setTimeout callback queue — so this wins the
			// Promise.race well before the 750ms timer would ever fire.
			const references = vi.fn().mockResolvedValue([
				{
					uri: pathToFileURL(reference).href,
					range: {
						start: { line: 1, character: 0 },
						end: { line: 1, character: 7 },
					},
				},
			]);
			mocks.getLSPService.mockReturnValue({
				getAllDiagnostics: vi
					.fn()
					.mockResolvedValue(
						new Map([
							[
								reference.split(path.sep).join("/"),
								{ diags: [lspError("reference broken")], ts: Date.now() },
							],
						]),
					),
				touchFile: vi.fn(),
				getDiagnostics: vi.fn(),
				references,
			});

			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			const result = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			expect(references).toHaveBeenCalled();
			expect(result?.result?.formatted).toContain("consumer.ts");
			// The core assertion: on pre-fix code this is 1 (the orphaned 750ms
			// reject timer) — the exact handle that would keep a one-shot
			// process alive after this call resolves.
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			env.cleanup();
			vi.useRealTimers();
		}
	});

	it("active-touches non-jsts neighbors silently", async () => {
		const env = setupTestEnvironment("cascade-python-");
		try {
			const primary = path.join(env.tmpDir, "model.py");
			const neighbor = path.join(env.tmpDir, "api.py");
			fs.writeFileSync(primary, "class User: pass\n");
			fs.writeFileSync(neighbor, "from model import User\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
			const touchFile = vi.fn().mockResolvedValue([lspError("python broken")]);
			mocks.getLSPService.mockReturnValue({
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile,
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			const result = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			expect(touchFile).toHaveBeenCalledWith(
				neighbor,
				expect.any(String),
				expect.objectContaining({
					silent: true,
					source: "cascade",
					clientScope: "all",
					collectDiagnostics: true,
				}),
			);
			expect(result?.result?.neighbors[0]?.lspTouched).toBe(true);
			expect(result?.result?.neighbors[0]?.diagnostics[0]?.message).toBe(
				"python broken",
			);
		} finally {
			env.cleanup();
		}
	});

	it("falls back to passive snapshot when graph neighbors produce no LSP data", async () => {
		const env = setupTestEnvironment("cascade-fallback-");
		try {
			// Primary must be a recognised code file so detectFileKind passes the
			// non_code_file guard. Neighbor uses an unknown extension so
			// configuredServerCount===0 prevents active touching — keeping
			// producedLspData false and triggering appendFallbackNeighbors.
			const primary = path.join(env.tmpDir, "main.ts");
			const noLspNeighbor = path.join(env.tmpDir, "neighbor.foo");
			const fallbackFile = path.join(env.tmpDir, "already-open.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			fs.writeFileSync(noLspNeighbor, "neighbor\n");
			fs.writeFileSync(fallbackFile, "const x = 1;\n");
			mocks.computeImpactCascade.mockReturnValue(
				impact(primary, [noLspNeighbor]),
			);
			const touchFile = vi.fn();
			mocks.getLSPService.mockReturnValue({
				getAllDiagnostics: vi
					.fn()
					.mockResolvedValue(
						new Map([
							[
								fallbackFile.split(path.sep).join("/"),
								{ diags: [lspError("fallback error")], ts: Date.now() },
							],
						]),
					),
				touchFile,
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			const result = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			expect(touchFile).not.toHaveBeenCalled();
			expect(
				result?.result?.neighbors.some((n) => n.reason === "fallback"),
			).toBe(true);
			expect(result?.result?.formatted).toContain("fallback error");
		} finally {
			env.cleanup();
		}
	});

	it("active-touches jsts neighbor when snapshot is missing (cold session)", async () => {
		const env = setupTestEnvironment("cascade-cold-snapshot-");
		try {
			const primary = path.join(env.tmpDir, "src", "primary.ts");
			const neighbor = path.join(env.tmpDir, "src", "neighbor.ts");
			fs.mkdirSync(path.dirname(primary), { recursive: true });
			fs.writeFileSync(primary, "export const x = 1;\n");
			fs.writeFileSync(neighbor, "import { x } from './primary';\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
			const touchFile = vi
				.fn()
				.mockResolvedValue([lspError("type error in neighbor")]);
			mocks.getLSPService.mockReturnValue({
				// Empty allDiags — no snapshot for neighbor (cold session)
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile,
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			const result = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			// Should have fallen through to active touch with tighter 1000ms budget
			expect(touchFile).toHaveBeenCalledWith(
				neighbor,
				expect.any(String),
				expect.objectContaining({
					silent: true,
					source: "cascade",
					collectDiagnostics: true,
					maxClientWaitMs: 1000,
				}),
			);
			expect(result?.result?.neighbors[0]?.lspTouched).toBe(true);
			expect(result?.result?.neighbors[0]?.diagnostics[0]?.message).toBe(
				"type error in neighbor",
			);
		} finally {
			env.cleanup();
		}
	});

	it("#458: skips the in-lane wait for a tier-3 (push-only, silent-on-clean) neighbor touch and records it outstanding", async () => {
		const env = setupTestEnvironment("cascade-tier3-skip-");
		try {
			const primary = path.join(env.tmpDir, "src", "primary.ts");
			const neighbor = path.join(env.tmpDir, "src", "neighbor.ts");
			fs.mkdirSync(path.dirname(primary), { recursive: true });
			fs.writeFileSync(primary, "export const x = 1;\n");
			fs.writeFileSync(neighbor, "import { x } from './primary';\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));

			const beforeTouch = Date.now();
			const touchFile = vi.fn();
			const getClientForFile = vi.fn().mockResolvedValue({
				client: { serverId: "typescript" },
			});
			const getCapabilitySnapshots = vi.fn().mockResolvedValue([
				{
					serverId: "typescript",
					root: env.tmpDir,
					operationSupport: {},
					workspaceDiagnosticsSupport: { mode: "push-only" },
					advertisedCommands: [],
					rawCapabilityKeys: [],
				},
			]);
			mocks.getLSPService.mockReturnValue({
				// Empty allDiags — no snapshot for neighbor (cold session), forces
				// the active-touch branch rather than the passive-snapshot read.
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				getCapabilitySnapshots,
				getClientForFile,
				touchFile,
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			const { _getOutstandingCascadeTouchesForTests } = await import(
				"../../clients/lsp/cascade-tier.js"
			);

			const result = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			// The wait-skipping touch still fires the notify (didOpen/didChange),
			// just with the wait disabled — never a wholesale no-touch.
			expect(touchFile).toHaveBeenCalledWith(
				neighbor,
				expect.any(String),
				expect.objectContaining({
					diagnostics: "none",
					collectDiagnostics: false,
					clientScope: "primary",
				}),
			);
			// Recorded outstanding for the quiet-window reconcile — not silently
			// dropped, not silently treated as clean.
			const outstanding = _getOutstandingCascadeTouchesForTests();
			expect(outstanding).toHaveLength(1);
			expect(outstanding[0]).toMatchObject({ serverId: "typescript" });
			// touchedAt is sampled BEFORE the notify (pre-touchFile), so a publish
			// racing the record can never be misread as pre-touch at reconcile.
			expect(outstanding[0].touchedAt).toBeGreaterThanOrEqual(beforeTouch);
			expect(outstanding[0].touchedAt).toBeLessThanOrEqual(Date.now());
			// No trustworthy diagnostics were produced by this touch, so the
			// degraded-fallback path (empty diagnostics, not "clean") applies —
			// never a false "no errors" for a skipped wait.
			expect(result?.result?.neighbors[0]?.diagnostics ?? []).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("#458: PI_LENS_TIER_AWARE_CASCADE=0 disables the skip — tier-3 neighbor still waits in-lane", async () => {
		const original = process.env.PI_LENS_TIER_AWARE_CASCADE;
		process.env.PI_LENS_TIER_AWARE_CASCADE = "0";
		const env = setupTestEnvironment("cascade-tier3-killswitch-");
		try {
			const primary = path.join(env.tmpDir, "src", "primary.ts");
			const neighbor = path.join(env.tmpDir, "src", "neighbor.ts");
			fs.mkdirSync(path.dirname(primary), { recursive: true });
			fs.writeFileSync(primary, "export const x = 1;\n");
			fs.writeFileSync(neighbor, "import { x } from './primary';\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));

			const touchFile = vi
				.fn()
				.mockResolvedValue([lspError("type error in neighbor")]);
			const getCapabilitySnapshots = vi.fn();
			const getClientForFile = vi.fn();
			mocks.getLSPService.mockReturnValue({
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				getCapabilitySnapshots,
				getClientForFile,
				touchFile,
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile, resetDispatchBaselines: _reset } =
				await import("../../clients/dispatch/integration.js");
			const { _resetTierAwareCascadeEnabledForTests } = await import(
				"../../clients/lsp/cascade-tier.js"
			);
			_resetTierAwareCascadeEnabledForTests();

			await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			// Kill switch off: classification is never even attempted, and the
			// full in-lane wait (collectDiagnostics: true) is used, same as before #458.
			expect(getCapabilitySnapshots).not.toHaveBeenCalled();
			expect(touchFile).toHaveBeenCalledWith(
				neighbor,
				expect.any(String),
				expect.objectContaining({ collectDiagnostics: true }),
			);
		} finally {
			env.cleanup();
			if (original === undefined) {
				delete process.env.PI_LENS_TIER_AWARE_CASCADE;
			} else {
				process.env.PI_LENS_TIER_AWARE_CASCADE = original;
			}
			const { _resetTierAwareCascadeEnabledForTests } = await import(
				"../../clients/lsp/cascade-tier.js"
			);
			_resetTierAwareCascadeEnabledForTests();
		}
	});

	it("does not touch jsts neighbor when snapshot is valid (warm session)", async () => {
		const env = setupTestEnvironment("cascade-warm-snapshot-");
		try {
			const primary = path.join(env.tmpDir, "src", "primary.ts");
			const neighbor = path.join(env.tmpDir, "src", "neighbor.ts");
			fs.mkdirSync(path.dirname(primary), { recursive: true });
			fs.writeFileSync(primary, "export const x = 1;\n");
			fs.writeFileSync(neighbor, "import { x } from './primary';\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
			const touchFile = vi.fn();
			mocks.getLSPService.mockReturnValue({
				getAllDiagnostics: vi
					.fn()
					.mockResolvedValue(
						new Map([
							[
								neighbor.split(path.sep).join("/"),
								{ diags: [lspError("existing warning")], ts: Date.now() },
							],
						]),
					),
				touchFile,
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			const result = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			// Valid snapshot — no touch should happen
			expect(touchFile).not.toHaveBeenCalled();
			expect(result?.result?.neighbors[0]?.lspTouched).toBe(false);
			expect(result?.result?.neighbors[0]?.diagnostics[0]?.message).toBe(
				"existing warning",
			);
		} finally {
			env.cleanup();
		}
	});

	it("filters repeated cascade diagnostics through cascade delta baselines", async () => {
		const env = setupTestEnvironment("cascade-delta-");
		try {
			const primary = path.join(env.tmpDir, "src", "primary.ts");
			const neighbor = path.join(env.tmpDir, "src", "neighbor.ts");
			fs.mkdirSync(path.dirname(primary), { recursive: true });
			fs.writeFileSync(primary, "export const x = 1;\n");
			fs.writeFileSync(neighbor, "import { x } from './primary';\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
			mocks.getLSPService.mockReturnValue({
				getAllDiagnostics: vi
					.fn()
					.mockResolvedValue(
						new Map([
							[
								neighbor.split(path.sep).join("/"),
								{ diags: [lspError("same error")], ts: Date.now() },
							],
						]),
					),
				touchFile: vi.fn(),
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			const first = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});
			const second = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 2,
				writeSeq: 1,
			});

			expect(first?.result?.formatted).toContain("same error");
			expect(second?.result).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("re-touches neighbor when writeSeq advances within the same turn", async () => {
		// Uses .ts files (cold snapshot path) so getServersForFileWithConfig reliably
		// returns a server. Two primaries cascade to the same neighbor in the same turn
		// with different writeSeq values — the second must re-touch, not use the cache.
		const env = setupTestEnvironment("cascade-writeseq-");
		try {
			const primaryA = path.join(env.tmpDir, "src", "a.ts");
			const primaryB = path.join(env.tmpDir, "src", "b.ts");
			const neighbor = path.join(env.tmpDir, "src", "shared.ts");
			fs.mkdirSync(path.dirname(primaryA), { recursive: true });
			fs.writeFileSync(primaryA, "export const a = 1;\n");
			fs.writeFileSync(primaryB, "export const b = 2;\n");
			fs.writeFileSync(neighbor, "import { a } from './a';\n");

			// Neighbor goes through cold-snapshot path (allDiags empty → no snapshot →
			// falls into touch pool). First cascade sets cache at writeSeq=1.
			const touchFile = vi
				.fn()
				.mockResolvedValueOnce([lspError("error1")])
				.mockResolvedValueOnce([lspError("error2")]);
			mocks.getLSPService.mockReturnValue({
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile,
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile, resetDispatchBaselines } = await import(
				"../../clients/dispatch/integration.js"
			);
			resetDispatchBaselines();

			mocks.computeImpactCascade.mockReturnValueOnce(
				impact(primaryA, [neighbor]),
			);
			await computeCascadeForFile(primaryA, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});
			expect(touchFile).toHaveBeenCalledTimes(1);

			// Same turn, higher writeSeq — cache entry (writeSeq=1) must be invalidated
			mocks.computeImpactCascade.mockReturnValueOnce(
				impact(primaryB, [neighbor]),
			);
			const second = await computeCascadeForFile(primaryB, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 2,
			});

			expect(touchFile).toHaveBeenCalledTimes(2);
			expect(second?.result?.neighbors[0]?.diagnostics[0]?.message).toBe(
				"error2",
			);
		} finally {
			env.cleanup();
		}
	});

	it("suppresses an ignored neighbour from cascade snapshot output (#297)", async () => {
		const env = setupTestEnvironment("cascade-ignore-snapshot-");
		try {
			// Anchor the ignore matcher at tmpDir (a .git marker stops
			// resolveGitIgnoreRoot's upward walk) and ignore test files there.
			fs.mkdirSync(path.join(env.tmpDir, ".git"), { recursive: true });
			fs.writeFileSync(
				path.join(env.tmpDir, ".pi-lens.json"),
				JSON.stringify({ ignore: ["**/*.test.ts"] }),
			);
			const primary = path.join(env.tmpDir, "src", "reader.ts");
			const ignoredNeighbor = path.join(env.tmpDir, "src", "reader.test.ts");
			fs.mkdirSync(path.dirname(primary), { recursive: true });
			fs.writeFileSync(primary, "export const countTotal = 1;\n");
			fs.writeFileSync(
				ignoredNeighbor,
				"import { countTotal } from './reader';\n",
			);
			// The test file is a direct importer (a cascade neighbour) AND carries an
			// LSP error in the passive snapshot — the exact #297 false-positive shape.
			mocks.computeImpactCascade.mockReturnValue(
				impact(primary, [ignoredNeighbor]),
			);
			mocks.getLSPService.mockReturnValue({
				getAllDiagnostics: vi
					.fn()
					.mockResolvedValue(
						new Map([
							[
								ignoredNeighbor.split(path.sep).join("/"),
								{ diags: [lspError("countTotal not found")], ts: Date.now() },
							],
						]),
					),
				touchFile: vi.fn(),
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			const result = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			// The ignored test file must not surface as a cascade neighbour.
			expect(result?.result).toBeUndefined();
			expect(result?.skipReason).toBe("no_neighbors");
		} finally {
			env.cleanup();
		}
	});

	it("suppresses an ignored neighbour from cascade fallback output (#297)", async () => {
		const env = setupTestEnvironment("cascade-ignore-fallback-");
		try {
			fs.mkdirSync(path.join(env.tmpDir, ".git"), { recursive: true });
			fs.writeFileSync(
				path.join(env.tmpDir, ".pi-lens.json"),
				JSON.stringify({ ignore: ["**/*.test.ts"] }),
			);
			// No-LSP neighbour keeps producedLspData false → fallback path runs and
			// scans every open file in allDiags, including the ignored test file.
			const primary = path.join(env.tmpDir, "main.ts");
			const noLspNeighbor = path.join(env.tmpDir, "neighbor.foo");
			const ignoredOpen = path.join(env.tmpDir, "src", "main.test.ts");
			fs.mkdirSync(path.dirname(ignoredOpen), { recursive: true });
			fs.writeFileSync(primary, "export const x = 1;\n");
			fs.writeFileSync(noLspNeighbor, "neighbor\n");
			fs.writeFileSync(ignoredOpen, "const x = 1;\n");
			mocks.computeImpactCascade.mockReturnValue(
				impact(primary, [noLspNeighbor]),
			);
			mocks.getLSPService.mockReturnValue({
				getAllDiagnostics: vi
					.fn()
					.mockResolvedValue(
						new Map([
							[
								ignoredOpen.split(path.sep).join("/"),
								{ diags: [lspError("ignored fallback error")], ts: Date.now() },
							],
						]),
					),
				touchFile: vi.fn(),
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			const result = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			expect(result?.result?.formatted ?? "").not.toContain(
				"ignored fallback error",
			);
			expect(
				result?.result?.neighbors.some((n) => n.reason === "fallback"),
			).not.toBe(true);
		} finally {
			env.cleanup();
		}
	});

	// ── #1080: test-role neighbors excluded from collateral cascade surfaces ──

	it("excludes an UNIGNORED test-role graph neighbour but keeps a source neighbour (#1080)", async () => {
		const env = setupTestEnvironment("cascade-test-role-graph-");
		try {
			const primary = path.join(env.tmpDir, "src", "reader.ts");
			const sourceNeighbor = path.join(env.tmpDir, "src", "consumer.ts");
			const testNeighbor = path.join(env.tmpDir, "src", "consumer.test.ts");
			fs.mkdirSync(path.dirname(primary), { recursive: true });
			fs.writeFileSync(primary, "export const countTotal = 1;\n");
			fs.writeFileSync(
				sourceNeighbor,
				"import { countTotal } from './reader';\n",
			);
			fs.writeFileSync(
				testNeighbor,
				"import { countTotal } from './reader';\n",
			);
			// Both the source AND the test file are direct importers with a passive
			// snapshot error — the test file is NOT ignored (no .pi-lens.json), so
			// only the #1080 role filter can drop it.
			mocks.computeImpactCascade.mockReturnValue(
				impact(primary, [sourceNeighbor, testNeighbor]),
			);
			const touchFile = vi.fn();
			mocks.getLSPService.mockReturnValue({
				getAllDiagnostics: vi.fn().mockResolvedValue(
					new Map([
						[
							sourceNeighbor.split(path.sep).join("/"),
							{ diags: [lspError("consumer error")], ts: Date.now() },
						],
						[
							testNeighbor.split(path.sep).join("/"),
							{ diags: [lspError("test error")], ts: Date.now() },
						],
					]),
				),
				touchFile,
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			const result = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			// Only the source neighbour surfaces / is read.
			expect(touchFile).not.toHaveBeenCalled();
			const neighborFiles = result?.result?.neighbors.map((n) =>
				n.filePath.split(path.sep).join("/"),
			);
			expect(neighborFiles).toEqual([sourceNeighbor.split(path.sep).join("/")]);
			// The header input (impact) — read verbatim by formatImpactCascade — is
			// also clean: the test file leaks through neither Direct importers nor
			// Check next counts/names.
			const impactNeighbors = result?.result?.impact.neighborFiles ?? [];
			expect(impactNeighbors).toContain(sourceNeighbor);
			expect(impactNeighbors).not.toContain(testNeighbor);
			expect(result?.result?.impact.directImporters).not.toContain(testNeighbor);
		} finally {
			env.cleanup();
		}
	});

	it("does not surface or touch an LSP reference that points at a test file (#1080)", async () => {
		const env = setupTestEnvironment("cascade-test-role-refs-");
		try {
			const primary = path.join(env.tmpDir, "src", "primary.ts");
			const sourceRef = path.join(env.tmpDir, "src", "consumer.ts");
			const testRef = path.join(env.tmpDir, "src", "consumer.test.ts");
			fs.mkdirSync(path.dirname(primary), { recursive: true });
			fs.writeFileSync(primary, "export function changed() { return 1; }\n");
			fs.writeFileSync(
				sourceRef,
				"import { changed } from './primary';\nchanged();\n",
			);
			fs.writeFileSync(
				testRef,
				"import { changed } from './primary';\nchanged();\n",
			);

			const graph = emptyGraph();
			const normalizedPrimary = primary.split(path.sep).join("/");
			const symbolId = `${normalizedPrimary}:changed`;
			graph.symbolNodesByFile.set(normalizedPrimary, [symbolId]);
			graph.nodes.set(symbolId, {
				id: symbolId,
				kind: "symbol",
				language: "jsts",
				filePath: normalizedPrimary,
				symbolName: "changed",
				symbolKind: "function",
				metadata: { line: 1, column: 17 },
			});
			mocks.buildOrUpdateGraph.mockResolvedValue(graph);
			mocks.computeImpactCascade.mockReturnValue({
				...impact(primary, []),
				changedSymbols: ["changed"],
			});
			const references = vi.fn().mockResolvedValue([
				{
					uri: pathToFileURL(sourceRef).href,
					range: {
						start: { line: 1, character: 0 },
						end: { line: 1, character: 7 },
					},
				},
				{
					uri: pathToFileURL(testRef).href,
					range: {
						start: { line: 1, character: 0 },
						end: { line: 1, character: 7 },
					},
				},
			]);
			const touchFile = vi.fn();
			mocks.getLSPService.mockReturnValue({
				getAllDiagnostics: vi.fn().mockResolvedValue(
					new Map([
						[
							sourceRef.split(path.sep).join("/"),
							{ diags: [lspError("consumer broke")], ts: Date.now() },
						],
						[
							testRef.split(path.sep).join("/"),
							{ diags: [lspError("test broke")], ts: Date.now() },
						],
					]),
				),
				touchFile,
				getDiagnostics: vi.fn(),
				references,
			});

			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			const result = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			const neighborKeys = (result?.result?.neighbors ?? []).map((n) =>
				n.filePath.split(path.sep).join("/"),
			);
			expect(neighborKeys).toContain(sourceRef.split(path.sep).join("/"));
			expect(neighborKeys).not.toContain(testRef.split(path.sep).join("/"));
			// The test reference is never a surfaced neighbour in the impact object.
			const impactKeys = (result?.result?.impact.neighborFiles ?? []).map((f) =>
				f.split(path.sep).join("/"),
			);
			expect(impactKeys).not.toContain(testRef.split(path.sep).join("/"));
		} finally {
			env.cleanup();
		}
	});

	it("drops an unignored test file from fallback, keeps source, still drops ignored (#1080/#297)", async () => {
		const env = setupTestEnvironment("cascade-test-role-fallback-");
		try {
			fs.mkdirSync(path.join(env.tmpDir, ".git"), { recursive: true });
			fs.writeFileSync(
				path.join(env.tmpDir, ".pi-lens.json"),
				JSON.stringify({ ignore: ["**/vendored.test.ts"] }),
			);
			const primary = path.join(env.tmpDir, "main.ts");
			const noLspNeighbor = path.join(env.tmpDir, "neighbor.foo");
			const normalSource = path.join(env.tmpDir, "src", "helper.ts");
			const unignoredTest = path.join(env.tmpDir, "src", "reader.test.ts");
			const ignoredTest = path.join(env.tmpDir, "src", "vendored.test.ts");
			fs.mkdirSync(path.join(env.tmpDir, "src"), { recursive: true });
			fs.writeFileSync(primary, "export const x = 1;\n");
			fs.writeFileSync(noLspNeighbor, "neighbor\n");
			fs.writeFileSync(normalSource, "const x = 1;\n");
			fs.writeFileSync(unignoredTest, "const x = 1;\n");
			fs.writeFileSync(ignoredTest, "const x = 1;\n");
			mocks.computeImpactCascade.mockReturnValue(
				impact(primary, [noLspNeighbor]),
			);
			mocks.getLSPService.mockReturnValue({
				getAllDiagnostics: vi.fn().mockResolvedValue(
					new Map([
						[
							normalSource.split(path.sep).join("/"),
							{ diags: [lspError("normal source error")], ts: Date.now() },
						],
						[
							unignoredTest.split(path.sep).join("/"),
							{ diags: [lspError("unignored test error")], ts: Date.now() },
						],
						[
							ignoredTest.split(path.sep).join("/"),
							{ diags: [lspError("ignored test error")], ts: Date.now() },
						],
					]),
				),
				touchFile: vi.fn(),
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			const result = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			const formatted = result?.result?.formatted ?? "";
			// Only the normal source diagnostic is shown.
			expect(formatted).toContain("normal source error");
			expect(formatted).not.toContain("unignored test error");
			expect(formatted).not.toContain("ignored test error");
			const fallbackFiles = (result?.result?.neighbors ?? [])
				.filter((n) => n.reason === "fallback")
				.map((n) => n.filePath.split(path.sep).join("/"));
			expect(fallbackFiles).toContain(normalSource.split(path.sep).join("/"));
			expect(fallbackFiles).not.toContain(
				unignoredTest.split(path.sep).join("/"),
			);
			expect(fallbackFiles).not.toContain(ignoredTest.split(path.sep).join("/"));
		} finally {
			env.cleanup();
		}
	});

	// #1023 over-correction guard: a HEALTHY graph (mode "full") with a genuinely
	// empty dependent set is a real clean leaf — it must stay `no_neighbors`, NOT
	// `indeterminate`, and emit NO advisory. The `impact()` helper carries no
	// `indeterminate` marker, and the default build-info mode is "full".
	it("returns no_neighbors (not indeterminate) for a healthy graph with zero dependents", async () => {
		const env = setupTestEnvironment("cascade-empty-");
		try {
			const primary = path.join(env.tmpDir, "primary.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, []));
			mocks.getLSPService.mockReturnValue({
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile: vi.fn(),
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			const run = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});
			expect(run.result).toBeUndefined();
			expect(run.skipReason).toBe("no_neighbors");
			expect(run.indeterminate).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	// #1023: a MISSING-NODE compute (computeImpactCascade marks the result
	// indeterminate because the changed file has no graph node) must NOT collapse
	// into `no_neighbors` — it is "couldn't compute", not "nothing impacted".
	it("returns indeterminate when the impact result is marked indeterminate (missing node)", async () => {
		const env = setupTestEnvironment("cascade-missing-node-");
		try {
			const primary = path.join(env.tmpDir, "primary.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			mocks.computeImpactCascade.mockReturnValue({
				...impact(primary, []),
				indeterminate: { reason: "missing_node" },
			});
			mocks.getLSPService.mockReturnValue({
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile: vi.fn(),
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			const run = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});
			expect(run.result).toBeUndefined();
			expect(run.skipReason).toBe("indeterminate");
			expect(run.indeterminate?.reason).toBe("missing_node");
		} finally {
			env.cleanup();
		}
	});

	it("returns indeterminate when the review graph source walk was truncated", async () => {
		const env = setupTestEnvironment("cascade-source-budget-");
		try {
			const primary = path.join(env.tmpDir, "primary.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			mocks.buildOrUpdateGraph.mockResolvedValue({
				...emptyGraph(),
				persistCoverage: {
					partial: true,
					cap: 500_000,
					totalNodes: 0,
					totalEdges: 0,
					persistedNodes: 0,
					persistedEdges: 0,
					totalFiles: 2,
					persistedFiles: 0,
					sourceFilesTruncated: true,
				},
			});
			mocks.computeImpactCascade.mockReturnValue(impact(primary, []));
			mocks.getLSPService.mockReturnValue({
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile: vi.fn(),
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			const run = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});
			expect(run.result).toBeUndefined();
			expect(run.skipReason).toBe("indeterminate");
			expect(run.indeterminate?.reason).toBe("graph_degraded");
			expect(run.indeterminate?.detail).toContain("source walk");
		} finally {
			env.cleanup();
		}
	});

	// #1023: a SIZE-SKIPPED graph (getLastGraphBuildInfo().mode === "skipped",
	// too_many_files) — the ALREADY-KNOWN degraded state is threaded onto the
	// result at the compute site. Every edit computes zero neighbors against the
	// empty graph; this must surface as `indeterminate`, not a silent all-clear.
	it("returns indeterminate when the review graph was size-skipped (too_many_files)", async () => {
		const env = setupTestEnvironment("cascade-size-skip-");
		try {
			const primary = path.join(env.tmpDir, "primary.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			// A healthy-looking (non-marked) empty impact — the degradation is known
			// ONLY via the build-info slot, exactly as in production.
			mocks.computeImpactCascade.mockReturnValue(impact(primary, []));
			mocks.getLSPService.mockReturnValue({
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile: vi.fn(),
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			const { _setLastGraphBuildInfoForTests } = await import(
				"../../clients/review-graph/builder.js"
			);
			_setLastGraphBuildInfoForTests({
				reused: false,
				mode: "skipped",
				skipReason: "too_many_files",
				sourceFileCount: 5000,
				maxFileCount: 4000,
			} as any);

			const run = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});
			expect(run.result).toBeUndefined();
			expect(run.skipReason).toBe("indeterminate");
			expect(run.indeterminate?.reason).toBe("graph_degraded");
			expect(run.indeterminate?.detail).toContain("5000");
		} finally {
			env.cleanup();
		}
	});

	// #1093/#1092: the cascade computes the correcting cross-file truth for every
	// edited file's dependents, but that truth used to be display-only and was
	// never reconciled into the footer widget. So a finding in A caused by B,
	// fixed by editing B, survived in A's footer forever (A's own mtime never
	// advanced). These prove the confirmed neighbor results now reconcile into
	// widget state — INCLUDING the confirmed-clean `[]` case — while inconclusive
	// results and stale write-ordering tokens are respected.
	describe("neighbor reconciliation into widget state (#1093/#1092)", () => {
		it("a confirmed-CLEAN passive snapshot clears a neighbor's now-stale footer entry", async () => {
			const env = setupTestEnvironment("cascade-reconcile-clean-");
			try {
				const primary = path.join(env.tmpDir, "src", "primary.ts");
				const neighbor = path.join(env.tmpDir, "src", "neighbor.ts");
				fs.mkdirSync(path.dirname(primary), { recursive: true });
				fs.writeFileSync(primary, "export const x = 1;\n");
				fs.writeFileSync(neighbor, "import { x } from './primary';\n");
				mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
				// Passive snapshot for the neighbor is now CLEAN (the fix to `primary`
				// resolved the cross-file error) — a valid, confirmed observation.
				mocks.getLSPService.mockReturnValue({
					getAllDiagnostics: vi
						.fn()
						.mockResolvedValue(
							new Map([
								[
									neighbor.split(path.sep).join("/"),
									{ diags: [], ts: Date.now() },
								],
							]),
						),
					touchFile: vi.fn(),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } = await import(
					"../../clients/dispatch/integration.js"
				);
				const { recordDiagnostics, getFileDiagnostics } = await import(
					"../../clients/widget-state.js"
				);

				// A stale LSP footer entry for the neighbor, left over from before the
				// fix (the per-edit LSP runner tags language-server findings tool:"lsp").
				recordDiagnostics(
					neighbor,
					[
						{
							tool: "lsp",
							severity: "error",
							semantic: "blocking",
							message: "cross-file error (already fixed)",
						},
					],
					1,
				);
				expect(getFileDiagnostics(neighbor)).toHaveLength(1);

				await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 5,
				});

				// Pre-fix: cascade never reconciled → the stale entry survived.
				expect(getFileDiagnostics(neighbor)).toEqual([]);
			} finally {
				env.cleanup();
			}
		});

		it("a confirmed active touch writes the neighbor's diagnostics into the footer", async () => {
			const env = setupTestEnvironment("cascade-reconcile-dirty-");
			try {
				const primary = path.join(env.tmpDir, "model.py");
				const neighbor = path.join(env.tmpDir, "api.py");
				fs.writeFileSync(primary, "class User: pass\n");
				fs.writeFileSync(neighbor, "from model import User\n");
				mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
				mocks.getLSPService.mockReturnValue({
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					touchFile: vi.fn().mockResolvedValue([lspError("python broken")]),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } = await import(
					"../../clients/dispatch/integration.js"
				);
				const { getFileDiagnostics } = await import(
					"../../clients/widget-state.js"
				);

				await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});

				// Pre-fix: cascade output was display-only → nothing written here.
				const diags = getFileDiagnostics(neighbor);
				expect(diags).toHaveLength(1);
				expect(diags?.[0]?.message).toBe("python broken");
			} finally {
				env.cleanup();
			}
		});

		it("an INCONCLUSIVE neighbor result (rejected touch → passive fallback) does NOT overwrite an existing footer entry", async () => {
			const env = setupTestEnvironment("cascade-reconcile-inconclusive-");
			try {
				const primary = path.join(env.tmpDir, "model.py");
				const neighbor = path.join(env.tmpDir, "api.py");
				fs.writeFileSync(primary, "class User: pass\n");
				fs.writeFileSync(neighbor, "from model import User\n");
				mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
				// The touch REJECTS — the neighbor falls back to a passive/stale
				// snapshot, which is NOT a confirmed observation and must not be
				// reconciled (#571 confirmed-only contract).
				mocks.getLSPService.mockReturnValue({
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					touchFile: vi.fn().mockRejectedValue(new Error("touch timed out")),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } = await import(
					"../../clients/dispatch/integration.js"
				);
				const { recordDiagnostics, getFileDiagnostics } = await import(
					"../../clients/widget-state.js"
				);

				// A real prior confirmed-dirty entry that must survive.
				recordDiagnostics(
					neighbor,
					[{ severity: "error", message: "real prior finding" }],
					1,
				);

				await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 5,
				});

				const diags = getFileDiagnostics(neighbor);
				expect(diags).toHaveLength(1);
				expect(diags?.[0]?.message).toBe("real prior finding");
			} finally {
				env.cleanup();
			}
		});

		it("a cascade reconcile with an OLDER writeSeq does not clobber a newer per-edit record; a NEWER writeSeq does win", async () => {
			const env = setupTestEnvironment("cascade-reconcile-ordering-");
			try {
				const primary = path.join(env.tmpDir, "src", "primary.ts");
				const neighbor = path.join(env.tmpDir, "src", "shared.ts");
				fs.mkdirSync(path.dirname(primary), { recursive: true });
				fs.writeFileSync(primary, "export const x = 1;\n");
				fs.writeFileSync(neighbor, "import { x } from './primary';\n");
				mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
				// No snapshot → cold-snapshot touch path; touch confirms an error.
				mocks.getLSPService.mockReturnValue({
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					touchFile: vi.fn().mockResolvedValue([lspError("cascade result")]),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile, resetDispatchBaselines } = await import(
					"../../clients/dispatch/integration.js"
				);
				const { recordDiagnostics, getFileDiagnostics } = await import(
					"../../clients/widget-state.js"
				);

				// A NEWER per-edit LSP-error record for the neighbor (writeIndex 10).
				recordDiagnostics(
					neighbor,
					[
						{
							tool: "lsp",
							severity: "error",
							semantic: "blocking",
							message: "newer per-edit result",
						},
					],
					10,
				);

				// Cascade launched from an OLDER primary edit (writeSeq 3) lands late —
				// its reconcile must be dropped by the WriteOrderingGuard.
				await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 3,
				});
				expect(getFileDiagnostics(neighbor)?.[0]?.message).toBe(
					"newer per-edit result",
				);

				// A later cascade with a NEWER writeSeq (20) is allowed to win —
				// proves the reconcile is actually firing (not silently a no-op) and
				// the token really is the cascade's writeSeq.
				resetDispatchBaselines();
				await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 20,
				});
				expect(getFileDiagnostics(neighbor)?.[0]?.message).toBe(
					"cascade result",
				);
			} finally {
				env.cleanup();
			}
		});

		it("an INCONCLUSIVE active touch (resolved [] carrying the inconclusive flag) does NOT wipe a live footer finding", async () => {
			const env = setupTestEnvironment("cascade-reconcile-inconclusive-touch-");
			try {
				const primary = path.join(env.tmpDir, "model.py");
				const neighbor = path.join(env.tmpDir, "api.py");
				fs.writeFileSync(primary, "class User: pass\n");
				fs.writeFileSync(neighbor, "from model import User\n");
				mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
				// The touch resolves `[]` but carries the `inconclusive: true` flag
				// (the diagnostics wait lapsed its budget) — NOT a confirmed clean.
				// Reconciling it as clean would wipe a live finding (the #533
				// false-clean trap). Set the flag exactly as the real `touchFile`
				// does — a NON-enumerable property — so this test also catches a
				// future regression where the code copies/spreads the array (which
				// drops a non-enumerable flag) before reading `inconclusive`.
				const inconclusive: unknown[] = [];
				Object.defineProperty(inconclusive, "inconclusive", {
					value: true,
					enumerable: false,
				});
				mocks.getLSPService.mockReturnValue({
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					touchFile: vi.fn().mockResolvedValue(inconclusive),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } = await import(
					"../../clients/dispatch/integration.js"
				);
				const { recordDiagnostics, getFileDiagnostics } = await import(
					"../../clients/widget-state.js"
				);

				// A live LSP error already recorded for the neighbor.
				recordDiagnostics(
					neighbor,
					[
						{
							tool: "lsp",
							severity: "error",
							semantic: "blocking",
							message: "live cross-file error",
						},
					],
					1,
				);

				await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 5,
				});

				// Pre-fix: the inconclusive `[]` reconciled as confirmed-clean and the
				// live finding was wiped. It must survive an unconfirmed touch.
				const diags = getFileDiagnostics(neighbor);
				expect(diags).toHaveLength(1);
				expect(diags?.[0]?.message).toBe("live cross-file error");

				// #1104: the neighbor_touch log entry must carry `inconclusive` so the
				// two unconfirmed-touch causes (inconclusive wait vs. bound-false disk
				// divergence) are distinguishable from cascade.log alone.
				const neighborTouchEntry = mocks.logCascade.mock.calls
					.map(([entry]) => entry)
					.find((entry) => entry.phase === "neighbor_touch");
				expect(neighborTouchEntry?.metadata).toMatchObject({
					inconclusive: true,
				});
			} finally {
				env.cleanup();
			}
		});

		it("a confirmed LSP-clean cascade clears the neighbor's LSP error but PRESERVES a live biome finding (merge, not replace)", async () => {
			const env = setupTestEnvironment("cascade-reconcile-merge-");
			try {
				const primary = path.join(env.tmpDir, "src", "primary.ts");
				const neighbor = path.join(env.tmpDir, "src", "neighbor.ts");
				fs.mkdirSync(path.dirname(primary), { recursive: true });
				fs.writeFileSync(primary, "export const x = 1;\n");
				fs.writeFileSync(neighbor, "import { x } from './primary';\n");
				mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
				// Passive snapshot reports the neighbor LSP-clean.
				mocks.getLSPService.mockReturnValue({
					getAllDiagnostics: vi
						.fn()
						.mockResolvedValue(
							new Map([
								[
									neighbor.split(path.sep).join("/"),
									{ diags: [], ts: Date.now() },
								],
							]),
						),
					touchFile: vi.fn(),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } = await import(
					"../../clients/dispatch/integration.js"
				);
				const { recordDiagnostics, getFileDiagnostics } = await import(
					"../../clients/widget-state.js"
				);

				// The neighbor's live footer state: a biome error (a source the cascade
				// never re-checks) AND an LSP error (which it does).
				recordDiagnostics(
					neighbor,
					[
						{ tool: "biome", severity: "error", message: "biome: unused var" },
						{
							tool: "lsp",
							severity: "error",
							semantic: "blocking",
							message: "lsp: cross-file error",
						},
					],
					1,
				);
				expect(getFileDiagnostics(neighbor)).toHaveLength(2);

				await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 5,
				});

				// The errors-only LSP re-check cleared its own stale error but must NOT
				// touch the biome finding. Pre-fix (full replace): the biome error was
				// silently wiped — a new automatic false-clean channel.
				const diags = getFileDiagnostics(neighbor);
				expect(diags?.map((d) => d.message)).toEqual(["biome: unused var"]);
			} finally {
				env.cleanup();
			}
		});

		it("a passive-snapshot reconcile stamps touchedAt at the snapshot's publish time (entry.ts), not now", async () => {
			const env = setupTestEnvironment("cascade-reconcile-snapshot-obs-");
			try {
				const primary = path.join(env.tmpDir, "src", "primary.ts");
				const neighbor = path.join(env.tmpDir, "src", "neighbor.ts");
				fs.mkdirSync(path.dirname(primary), { recursive: true });
				fs.writeFileSync(primary, "export const x = 1;\n");
				fs.writeFileSync(neighbor, "import { x } from './primary';\n");
				mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
				// The snapshot is 20s old (still within CASCADE_TTL_MS) and reports an
				// error — a valid, confirmed observation, but an AGING one.
				const snapshotTs = Date.now() - 20_000;
				mocks.getLSPService.mockReturnValue({
					getAllDiagnostics: vi.fn().mockResolvedValue(
						new Map([
							[
								neighbor.split(path.sep).join("/"),
								{ diags: [lspError("snapshot error")], ts: snapshotTs },
							],
						]),
					),
					touchFile: vi.fn(),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } = await import(
					"../../clients/dispatch/integration.js"
				);
				const { getFileDiagnostics, reconcileStaleWidgetFiles } = await import(
					"../../clients/widget-state.js"
				);

				await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 5,
				});
				expect(getFileDiagnostics(neighbor)).toHaveLength(1);

				// The neighbor file changed 10s ago — AFTER the snapshot's publish time
				// but before now. touchedAt must be the snapshot's `ts` (now-20s), so
				// the mtime-staleness gate drops the entry. Pre-fix (touchedAt=now, the
				// re-arming defect this PR fixes for cache hits): it would survive.
				const mtime = new Date(Date.now() - 10_000);
				fs.utimesSync(neighbor, mtime, mtime);
				expect(await reconcileStaleWidgetFiles()).toBe(1);
				expect(getFileDiagnostics(neighbor)).toBeUndefined();
			} finally {
				env.cleanup();
			}
		});

		it("does NOT double-count or escalate a neighbor's auxiliary (opengrep) finding present in the cascade payload", async () => {
			const env = setupTestEnvironment("cascade-reconcile-aux-");
			try {
				const primary = path.join(env.tmpDir, "model.py");
				const neighbor = path.join(env.tmpDir, "api.py");
				fs.writeFileSync(primary, "class User: pass\n");
				fs.writeFileSync(neighbor, "from model import User\n");
				mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
				// The touch (clientScope:"all") pulls the neighbor's OWN auxiliary
				// finding — opengrep tags its LSP diagnostics `source: "Semgrep"` —
				// alongside no genuine language-server error.
				const semgrep = {
					severity: 1 as const,
					message: "opengrep: audit finding",
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 1 },
					},
					code: "rules.audit",
					source: "Semgrep",
				};
				mocks.getLSPService.mockReturnValue({
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					touchFile: vi.fn().mockResolvedValue([semgrep]),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } = await import(
					"../../clients/dispatch/integration.js"
				);
				const { recordDiagnostics, getFileDiagnostics } = await import(
					"../../clients/widget-state.js"
				);

				// The neighbor already carries this opengrep finding, correctly tagged
				// and advisory (semantic "warning"), from its own per-edit dispatch.
				recordDiagnostics(
					neighbor,
					[
						{
							tool: "opengrep",
							severity: "error",
							semantic: "warning",
							message: "opengrep: audit finding",
						},
					],
					1,
				);

				await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 5,
				});

				// The cascade excludes auxiliary-sourced diagnostics from what it
				// reconciles, so the finding is neither duplicated nor re-written as a
				// blocking tool:"lsp" error — the neighbor's own correctly-tagged
				// advisory entry survives, exactly once. Pre-fix: two entries, one of
				// them escalated to tool:"lsp"/blocking.
				const diags = getFileDiagnostics(neighbor);
				expect(diags).toHaveLength(1);
				expect(diags?.[0]?.tool).toBe("opengrep");
				expect(diags?.[0]?.semantic).not.toBe("blocking");
			} finally {
				env.cleanup();
			}
		});
	});

	// #1095 (second PR): the cascade adopts the content `binding` carried by
	// diagnostics results. A passive snapshot / active touch whose diagnostics were
	// computed against a DIFFERENT disk state than what's on disk now
	// (boundToCurrentDisk === false) is no longer trusted — it is not reconciled into
	// the footer widget, killing the window where the first cascade after a fix-edit
	// replays the neighbor's PRE-fix snapshot. "unknown" preserves EXACTLY the
	// pre-#1095 TTL-only behavior; true reconciles (TTL stays the outer bound).
	describe("content-binding validity (#1095)", () => {
		it("does NOT reconcile a bound-false passive snapshot (stale pre-fix snapshot) and falls through to an active touch", async () => {
			const env = setupTestEnvironment("cascade-binding-false-snapshot-");
			try {
				const primary = path.join(env.tmpDir, "src", "primary.ts");
				const neighbor = path.join(env.tmpDir, "src", "neighbor.ts");
				fs.mkdirSync(path.dirname(primary), { recursive: true });
				fs.writeFileSync(primary, "export const x = 1;\n");
				fs.writeFileSync(neighbor, "import { x } from './primary';\n");
				mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
				// TTL-fresh snapshot still carrying the PRE-fix error, but the server's
				// view has diverged from disk (boundToCurrentDisk: false).
				mocks.getLSPService.mockReturnValue({
					getAllDiagnostics: vi.fn().mockResolvedValue(
						new Map([
							[
								neighbor.split(path.sep).join("/"),
								withBinding(
									{ diags: [lspError("pre-fix error")], ts: Date.now() },
									false,
								),
							],
						]),
					),
					// The neighbor is actually clean now — a confirmed active re-check.
					touchFile: vi.fn().mockResolvedValue([]),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } = await import(
					"../../clients/dispatch/integration.js"
				);
				const { getFileDiagnostics } = await import(
					"../../clients/widget-state.js"
				);

				const result = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 5,
				});

				// Pre-fix: the TTL-fresh snapshot was reconciled and its stale error
				// landed in the footer. With binding: the bound-false snapshot is skipped,
				// so the pre-fix error never reaches the widget…
				expect(getFileDiagnostics(neighbor) ?? []).toEqual([]);
				// …and the neighbor falls through to an active touch (same budget as a
				// cold/stale snapshot) instead of trusting the diverged snapshot.
				const lsp = mocks.getLSPService.mock.results[0]?.value;
				expect(lsp.touchFile).toHaveBeenCalledWith(
					neighbor,
					expect.any(String),
					expect.objectContaining({ source: "cascade", clientScope: "all" }),
				);
				// The stale snapshot error must not survive as a cascade neighbor result.
				expect(
					result?.result?.neighbors[0]?.diagnostics.some(
						(d) => d.message === "pre-fix error",
					) ?? false,
				).toBe(false);
			} finally {
				env.cleanup();
			}
		});

		it("characterization: an unknown-binding TTL-fresh snapshot reconciles exactly as pre-#1095 (no touch)", async () => {
			const env = setupTestEnvironment("cascade-binding-unknown-snapshot-");
			try {
				const primary = path.join(env.tmpDir, "src", "primary.ts");
				const neighbor = path.join(env.tmpDir, "src", "neighbor.ts");
				fs.mkdirSync(path.dirname(primary), { recursive: true });
				fs.writeFileSync(primary, "export const x = 1;\n");
				fs.writeFileSync(neighbor, "import { x } from './primary';\n");
				mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
				const touchFile = vi.fn();
				mocks.getLSPService.mockReturnValue({
					getAllDiagnostics: vi.fn().mockResolvedValue(
						new Map([
							[
								neighbor.split(path.sep).join("/"),
								withBinding(
									{ diags: [lspError("unknown-bound error")], ts: Date.now() },
									"unknown",
								),
							],
						]),
					),
					touchFile,
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } = await import(
					"../../clients/dispatch/integration.js"
				);
				const { getFileDiagnostics } = await import(
					"../../clients/widget-state.js"
				);

				const result = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 5,
				});

				// Unknown binding → TTL-only behavior: snapshot trusted, no active touch,
				// error surfaced and reconciled into the footer, identical to pre-#1095.
				expect(touchFile).not.toHaveBeenCalled();
				expect(result?.result?.neighbors[0]?.lspTouched).toBe(false);
				expect(result?.result?.neighbors[0]?.diagnostics[0]?.message).toBe(
					"unknown-bound error",
				);
				expect(getFileDiagnostics(neighbor)).toHaveLength(1);
			} finally {
				env.cleanup();
			}
		});

		it("reconciles a bound-true passive snapshot (no touch)", async () => {
			const env = setupTestEnvironment("cascade-binding-true-snapshot-");
			try {
				const primary = path.join(env.tmpDir, "src", "primary.ts");
				const neighbor = path.join(env.tmpDir, "src", "neighbor.ts");
				fs.mkdirSync(path.dirname(primary), { recursive: true });
				fs.writeFileSync(primary, "export const x = 1;\n");
				fs.writeFileSync(neighbor, "import { x } from './primary';\n");
				mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
				const touchFile = vi.fn();
				mocks.getLSPService.mockReturnValue({
					getAllDiagnostics: vi.fn().mockResolvedValue(
						new Map([
							[
								neighbor.split(path.sep).join("/"),
								withBinding(
									{ diags: [lspError("bound-true error")], ts: Date.now() },
									true,
								),
							],
						]),
					),
					touchFile,
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } = await import(
					"../../clients/dispatch/integration.js"
				);
				const { getFileDiagnostics } = await import(
					"../../clients/widget-state.js"
				);

				const result = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 5,
				});

				expect(touchFile).not.toHaveBeenCalled();
				expect(result?.result?.neighbors[0]?.diagnostics[0]?.message).toBe(
					"bound-true error",
				);
				expect(getFileDiagnostics(neighbor)).toHaveLength(1);
			} finally {
				env.cleanup();
			}
		});

		it("a bound-false active touch is not reconciled AND does not seed the recently-clean cache", async () => {
			const env = setupTestEnvironment("cascade-binding-false-touch-");
			try {
				// Python neighbor → active-touch path (no autoPropagate snapshot).
				const primary = path.join(env.tmpDir, "model.py");
				const neighbor = path.join(env.tmpDir, "api.py");
				fs.writeFileSync(primary, "class User: pass\n");
				fs.writeFileSync(neighbor, "from model import User\n");
				mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
				// The touch resolves `[]` but is bound-false (computed against a diverged
				// disk state) — NOT a confirmed clean, exactly like `inconclusive`.
				const touchFile = vi
					.fn()
					.mockImplementation(async () => withBinding([], false));
				mocks.getLSPService.mockReturnValue({
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					touchFile,
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } = await import(
					"../../clients/dispatch/integration.js"
				);
				const { recordDiagnostics, getFileDiagnostics } = await import(
					"../../clients/widget-state.js"
				);

				// A live prior LSP error the bound-false clean touch must NOT wipe.
				recordDiagnostics(
					neighbor,
					[
						{
							tool: "lsp",
							severity: "error",
							semantic: "blocking",
							message: "live cross-file error",
						},
					],
					1,
				);

				// Turn 1: bound-false clean touch — no reconcile.
				await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});
				// Pre-fix: the bound-false `[]` reconciled as confirmed-clean and wiped the
				// live finding. It must survive an unconfirmed touch.
				const afterFirst = getFileDiagnostics(neighbor);
				expect(afterFirst).toHaveLength(1);
				expect(afterFirst?.[0]?.message).toBe("live cross-file error");

				// Turn 2: because the bound-false clean touch did NOT seed the
				// recently-clean cache, the neighbor is re-touched (a seeded entry would
				// short-circuit turn 2). Proves no recently-clean seed occurred.
				await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 2,
					writeSeq: 2,
				});
				expect(touchFile).toHaveBeenCalledTimes(2);
			} finally {
				env.cleanup();
			}
		});
	});

	// #1104: the cascade's DEGRADED/FALLBACK display paths (the touch-error
	// fallback and appendFallbackNeighbors) previously re-read TTL-fresh
	// `getAllDiagnostics()` snapshots WITHOUT consulting content binding — #1100
	// gated the RECONCILE (footer/widget) path onto binding, but a bound-false
	// (pre-fix-edit) snapshot could still reach cascade OUTPUT via these two
	// tier3-silent corners. Tighten both to the same false/unknown/true contract
	// #1100/#1095 already established for reconcile, and verify filtering a
	// display candidate never quietly turns a degraded cascade into a
	// clean-looking one.
	describe("fallback-display binding gaps (#1104)", () => {
		it("touch-error fallback excludes a bound-false TTL-fresh snapshot from cascade DISPLAY output", async () => {
			const env = setupTestEnvironment("cascade-1104-touch-fallback-");
			try {
				const primary = path.join(env.tmpDir, "model.py");
				const rejectedNeighbor = path.join(env.tmpDir, "stale_api.py");
				const confirmedNeighbor = path.join(env.tmpDir, "live_api.py");
				fs.writeFileSync(primary, "class User: pass\n");
				fs.writeFileSync(rejectedNeighbor, "from model import User\n");
				fs.writeFileSync(confirmedNeighbor, "from model import User\n");
				mocks.computeImpactCascade.mockReturnValue(
					impact(primary, [rejectedNeighbor, confirmedNeighbor]),
				);
				mocks.getLSPService.mockReturnValue({
					// TTL-fresh snapshot for the neighbor whose active touch will fail —
					// but bound-false (the server's view diverged from current disk, a
					// pre-fix-edit read).
					getAllDiagnostics: vi.fn().mockResolvedValue(
						new Map([
							[
								rejectedNeighbor.split(path.sep).join("/"),
								withBinding(
									{ diags: [lspError("stale pre-fix error")], ts: Date.now() },
									false,
								),
							],
						]),
					),
					touchFile: vi
						.fn()
						.mockImplementation(async (filePath: string) => {
							if (filePath === rejectedNeighbor) {
								throw new Error("touch failed");
							}
							return [lspError("confirmed live error")];
						}),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } = await import(
					"../../clients/dispatch/integration.js"
				);
				const result = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});

				const rejected = result?.result?.neighbors.find(
					(n) => n.filePath === rejectedNeighbor,
				);
				// The stale/bound-false snapshot must not survive into the fallback
				// entry's displayed diagnostics.
				expect(rejected?.diagnostics ?? []).toEqual([]);
				expect(
					result?.result?.neighbors.some((n) =>
						n.diagnostics.some((d) => d.message === "stale pre-fix error"),
					),
				).toBe(false);
				// The genuinely confirmed neighbor's error still reaches output —
				// proves the fix is a targeted skip, not a blanket suppression.
				expect(result?.result?.formatted).toContain("confirmed live error");
			} finally {
				env.cleanup();
			}
		});

		it("characterization: touch-error fallback with unknown binding still displays the TTL-fresh snapshot exactly as before", async () => {
			const env = setupTestEnvironment("cascade-1104-touch-fallback-unknown-");
			try {
				const primary = path.join(env.tmpDir, "model.py");
				const neighbor = path.join(env.tmpDir, "api.py");
				fs.writeFileSync(primary, "class User: pass\n");
				fs.writeFileSync(neighbor, "from model import User\n");
				mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
				mocks.getLSPService.mockReturnValue({
					getAllDiagnostics: vi.fn().mockResolvedValue(
						new Map([
							[
								neighbor.split(path.sep).join("/"),
								withBinding(
									{ diags: [lspError("unknown-bound stale error")], ts: Date.now() },
									"unknown",
								),
							],
						]),
					),
					touchFile: vi.fn().mockRejectedValue(new Error("touch failed")),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } = await import(
					"../../clients/dispatch/integration.js"
				);
				const result = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});

				expect(
					result?.result?.neighbors[0]?.diagnostics[0]?.message,
				).toBe("unknown-bound stale error");
			} finally {
				env.cleanup();
			}
		});

		it("appendFallbackNeighbors excludes a bound-false TTL-fresh snapshot from cascade DISPLAY output", async () => {
			const env = setupTestEnvironment("cascade-1104-append-fallback-");
			try {
				const primary = path.join(env.tmpDir, "main.ts");
				// Unknown extension neighbor keeps producedLspData false (no LSP
				// server configured), driving the run into appendFallbackNeighbors
				// exactly like the pre-existing "falls back to passive snapshot" test.
				const noLspNeighbor = path.join(env.tmpDir, "neighbor.foo");
				const staleFile = path.join(env.tmpDir, "stale.ts");
				const liveFile = path.join(env.tmpDir, "live.ts");
				fs.writeFileSync(primary, "export const x = 1;\n");
				fs.writeFileSync(noLspNeighbor, "neighbor\n");
				fs.writeFileSync(staleFile, "const x = 1;\n");
				fs.writeFileSync(liveFile, "const y = 2;\n");
				mocks.computeImpactCascade.mockReturnValue(
					impact(primary, [noLspNeighbor]),
				);
				mocks.getLSPService.mockReturnValue({
					getAllDiagnostics: vi.fn().mockResolvedValue(
						new Map([
							[
								staleFile.split(path.sep).join("/"),
								withBinding(
									{ diags: [lspError("stale collateral error")], ts: Date.now() },
									false,
								),
							],
							[
								liveFile.split(path.sep).join("/"),
								{ diags: [lspError("live collateral error")], ts: Date.now() },
							],
						]),
					),
					touchFile: vi.fn(),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } = await import(
					"../../clients/dispatch/integration.js"
				);
				const result = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});

				expect(
					result?.result?.neighbors.some((n) => n.filePath === staleFile),
				).toBe(false);
				expect(result?.result?.formatted).not.toContain(
					"stale collateral error",
				);
				expect(result?.result?.formatted).toContain("live collateral error");
			} finally {
				env.cleanup();
			}
		});

		it("characterization: appendFallbackNeighbors with unknown binding still displays the collateral entry exactly as before", async () => {
			const env = setupTestEnvironment(
				"cascade-1104-append-fallback-unknown-",
			);
			try {
				const primary = path.join(env.tmpDir, "main.ts");
				const noLspNeighbor = path.join(env.tmpDir, "neighbor.foo");
				const fallbackFile = path.join(env.tmpDir, "already-open.ts");
				fs.writeFileSync(primary, "export const x = 1;\n");
				fs.writeFileSync(noLspNeighbor, "neighbor\n");
				fs.writeFileSync(fallbackFile, "const x = 1;\n");
				mocks.computeImpactCascade.mockReturnValue(
					impact(primary, [noLspNeighbor]),
				);
				mocks.getLSPService.mockReturnValue({
					getAllDiagnostics: vi.fn().mockResolvedValue(
						new Map([
							[
								fallbackFile.split(path.sep).join("/"),
								withBinding(
									{ diags: [lspError("unknown-bound fallback error")], ts: Date.now() },
									"unknown",
								),
							],
						]),
					),
					touchFile: vi.fn(),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } = await import(
					"../../clients/dispatch/integration.js"
				);
				const result = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});

				expect(result?.result?.formatted).toContain(
					"unknown-bound fallback error",
				);
			} finally {
				env.cleanup();
			}
		});

		it("HONESTY: when every appendFallbackNeighbors candidate is binding-rejected, the cascade still renders degraded/indeterminate — never a silent clean", async () => {
			const env = setupTestEnvironment("cascade-1104-honesty-");
			try {
				const primary = path.join(env.tmpDir, "main.ts");
				const noLspNeighbor = path.join(env.tmpDir, "neighbor.foo");
				const staleFile = path.join(env.tmpDir, "stale.ts");
				fs.writeFileSync(primary, "export const x = 1;\n");
				fs.writeFileSync(noLspNeighbor, "neighbor\n");
				fs.writeFileSync(staleFile, "const x = 1;\n");
				mocks.computeImpactCascade.mockReturnValue(
					impact(primary, [noLspNeighbor]),
				);
				mocks.getLSPService.mockReturnValue({
					getAllDiagnostics: vi.fn().mockResolvedValue(
						new Map([
							[
								staleFile.split(path.sep).join("/"),
								withBinding(
									{ diags: [lspError("withheld stale error")], ts: Date.now() },
									false,
								),
							],
						]),
					),
					touchFile: vi.fn(),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } = await import(
					"../../clients/dispatch/integration.js"
				);
				const result = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});

				// Not a genuine clean leaf: the withheld candidate must surface an
				// honest indeterminate advisory (#1023's doctrine, extended by
				// #1104) instead of silently looking clean/no_neighbors.
				expect(result?.skipReason).toBe("indeterminate");
				expect(result?.indeterminate?.reason).toBe("lsp_binding_rejected");
				expect(result?.result).toBeUndefined();
			} finally {
				env.cleanup();
			}
		});
	});
});
