/**
 * Dispatch integration helpers
 *
 * Provides utilities for integrating the declarative dispatch system
 * with the existing index.ts tool_result handler.
 */

import { getDiagnosticLogger, type LogContext } from "../diagnostic-logger.js";
import type { FileKind } from "../file-kinds.js";
import { detectFileKind } from "../file-kinds.js";
import {
	getLspCapableKinds,
	getPrimaryDispatchGroup,
} from "../language-policy.js";
import {
	formatSlopScoreSummary,
	type SlopScoreSummary,
} from "../session-summary.js";
import {
	clearCoverageNoticeState,
	clearLatencyReports,
	createDispatchContext,
	type DispatchLatencyReport,
	dispatchForFile,
	formatLatencyReport,
	getLatencyReports,
	type RunnerLatency,
	RunnerRegistry,
	type RunnerResultSink,
} from "./dispatcher.js";
import { FactStore } from "./fact-store.js";
import { TOOL_PLANS } from "./plan.js";
import type {
	DispatchResult,
	ModifiedRange,
	PiAgentAPI,
	RunnerGroup,
	RunnerResult,
} from "./types.js";

export type { DispatchLatencyReport, RunnerLatency };
// Re-export latency tracking types and functions
export { clearLatencyReports, formatLatencyReport, getLatencyReports };

import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { formatCascadeNeighborDiagnostics } from "../cascade-format.js";
import { logCascade } from "../cascade-logger.js";
import type {
	CascadeResult,
	CascadeRun,
	CascadeSkipReason,
} from "../cascade-types.js";
import { getDiagnosticTracker } from "../diagnostic-tracker.js";
import {
	isTierAwareCascadeEnabled,
	recordOutstandingCascadeTouch,
} from "../lsp/cascade-tier.js";
import { classifyCascadeWaitTier } from "../lsp/wait-policy/index.js";
import {
	type BoundToCurrentDisk,
	bindingStateLabel,
} from "../lsp/diagnostic-binding.js";
import { getServersForFileWithConfig } from "../lsp/config.js";
import { getLSPService } from "../lsp/index.js";
import { isExternalOrVendorFile, normalizeMapKey } from "../path-utils.js";
import { getProjectIgnoreMatcher } from "../file-utils.js";
import { isTestRoleCollateral } from "../collateral-test-role.js";
import {
	clearReviewGraphWorkspaceCache,
	getGraphBuildInfoForGraph,
	getGraphImportChanges,
} from "../review-graph/builder.js";
import {
	buildReverseDependencyIndexFromGraph,
	getAffectedFilesFromIndex,
	patchReverseDependencyIndex,
	writeReverseDependencyIndexToSnapshot,
	type ReverseDependencyIndex,
} from "../reverse-deps.js";
import {
	buildOrUpdateGraph,
	computeImpactCascade,
	computeTransitiveImpact,
	formatImpactCascade,
} from "../review-graph/service.js";
import { clearModuleGraphCache } from "../review-graph/workspace-modules.js";
import { RUNTIME_CONFIG } from "../runtime-config.js";
import {
	findCompiledClassesDir,
	hasJavaBuildDescriptor,
} from "../tool-policy.js";
import {
	removeWordIndexDocument,
	updateWordIndexDocument,
	WORD_INDEX_MAX_BYTES,
	type WordIndex,
} from "../word-index.js";
import { reconcileCascadeNeighborLspErrors } from "../widget-state.js";
import { findAuxiliaryProfileForSource } from "./auxiliary-lsp.js";
// Register fact providers. All register eagerly here (the dispatch entry) — the
// tree-sitter-backed providers included, since the parsing stack loads
// `web-tree-sitter` lazily inside client.init(), not at module import, so it
// stays out of the eager graph and degrades there rather than crashing at load.
import { registerProvider, runProviders } from "./fact-runner.js";
import { commentFactProvider } from "./facts/comment-facts.js";
import { fileContentProvider } from "./facts/file-content.js";
import { functionFactProvider } from "./facts/function-facts.js";
import { importFactProvider } from "./facts/import-facts.js";
import { tryCatchFactProvider } from "./facts/try-catch-facts.js";
import { resolveRunnerPath, toRunnerDisplayPath } from "./runner-context.js";
import { registerDefaultRunners } from "./runners/index.js";
import { convertLspDiagnostics } from "./utils/lsp-diagnostics.js";

registerProvider(fileContentProvider);
registerProvider(tryCatchFactProvider);
registerProvider(functionFactProvider);
registerProvider(commentFactProvider);
registerProvider(importFactProvider);

// Register fact rules
import { registerRule } from "./fact-rule-runner.js";
import { asyncNoiseRule } from "./rules/async-noise.js";
import { asyncUnnecessaryWrapperRule } from "./rules/async-unnecessary-wrapper.js";
import { corsWildcardRule } from "./rules/cors-wildcard.js";
import { errorObscuringRule } from "./rules/error-obscuring.js";
import { errorSwallowingRule } from "./rules/error-swallowing.js";
import { highComplexityRule } from "./rules/high-complexity.js";
import { highFanOutRule } from "./rules/high-fan-out.js";
import { highImportCouplingRule } from "./rules/high-import-coupling.js";
import { missingErrorPropagationRule } from "./rules/missing-error-propagation.js";
import { commentedCredentialsRule } from "./rules/no-commented-credentials.js";
import { passThroughWrappersRule } from "./rules/pass-through-wrappers.js";
import { placeholderCommentsRule } from "./rules/placeholder-comments.js";
import { unsafeBoundaryRule } from "./rules/unsafe-boundary.js";
import {
	loadPiLensProjectConfig,
	type PiLensProjectConfig,
} from "../project-lens-config.js";

registerRule(errorObscuringRule);
registerRule(errorSwallowingRule);
registerRule(asyncNoiseRule);
registerRule(passThroughWrappersRule);
registerRule(placeholderCommentsRule);
registerRule(highComplexityRule);
registerRule(unsafeBoundaryRule);
registerRule(asyncUnnecessaryWrapperRule);
registerRule(missingErrorPropagationRule);
registerRule(highFanOutRule);
registerRule(highImportCouplingRule);
registerRule(corsWildcardRule);
registerRule(commentedCredentialsRule);

/**
 * Load a project's `.pi-lens.json` config.
 *
 * Rule thresholds are consumed from `DispatchContext.projectConfig` during rule
 * evaluation, not applied to process-global module state. Keeping this helper as
 * a thin loader preserves the existing integration seam while avoiding
 * cross-workspace threshold bleed when multiple dispatches overlap.
 */
export function applyProjectLensConfig(cwd: string): PiLensProjectConfig {
	return loadPiLensProjectConfig(cwd);
}

const sessionFacts = new FactStore();
const cascadeDiagnosticBaselines = new Map<
	string,
	import("./types.js").Diagnostic[]
>();
const sessionRunnerRegistry = new RunnerRegistry();
registerDefaultRunners(sessionRunnerRegistry);
const LSP_CAPABLE_KINDS = new Set<FileKind>(getLspCapableKinds());
const FACT_RULE_IDS = new Set([
	"error-obscuring",
	"error-swallowing",
	"async-noise",
	"pass-through-wrappers",
	"placeholder-comments",
	"high-complexity",
	"unsafe-boundary",
	"async-unnecessary-wrapper",
	"missing-error-propagation",
	"high-fan-out",
	"commented-out-code",
	"duplicate-string-literal",
	"function-in-loop",
	"cors-wildcard",
	"dynamic-regexp",
	"max-switch-cases",
	"no-commented-credentials",
	"no-boolean-params",
	"high-import-coupling",
	"no-complex-conditionals",
]);
const sessionSlopRuleCounts = new Map<string, number>();
let sessionSlopDiagnosticCount = 0;
let sessionWrittenLineCount = 0;

// Debounced ast-grep warning scan — fires 2s after the last write to a jsts file.
// Runs warning-tier rules that are too expensive to include in the blocking write path,
// logs all diagnostics for history without surfacing anything to the agent.
const astGrepWarnDebounceTimers = new Map<
	string,
	ReturnType<typeof setTimeout>
>();
const AST_GREP_WARN_DEBOUNCE_MS = 2000;

function scheduleAstGrepWarningScan(
	filePath: string,
	cwd: string,
	pi: PiAgentAPI,
	logContext: LogContext,
): void {
	const existing = astGrepWarnDebounceTimers.get(filePath);
	if (existing) clearTimeout(existing);

	const timer = setTimeout(async () => {
		astGrepWarnDebounceTimers.delete(filePath);
		try {
			const ctx = createDispatchContext(filePath, cwd, pi, sessionFacts, false);
			if (ctx.kind !== "jsts") return;

			// Single-runner group: ast-grep only, warning mode (blockingOnly=false)
			const group: RunnerGroup = {
				mode: "all",
				runnerIds: ["ast-grep"],
				filterKinds: ["jsts"],
			};
			const result = await dispatchForFile(ctx, [group], sessionRunnerRegistry);
			if (result.diagnostics.length === 0) return;

			const logger = getDiagnosticLogger();
			for (const d of result.diagnostics) {
				logger.logCaught(d, logContext, false);
			}
		} catch {
			// Non-critical background scan — swallow errors silently
		}
	}, AST_GREP_WARN_DEBOUNCE_MS);

	astGrepWarnDebounceTimers.set(filePath, timer);
}

function resetSessionSlopScore(): void {
	sessionSlopRuleCounts.clear();
	sessionSlopDiagnosticCount = 0;
	sessionWrittenLineCount = 0;
}

function detectFactRuleId(diagnostic: {
	id?: string;
	rule?: string;
	tool?: string;
}): string | undefined {
	if (diagnostic.rule && FACT_RULE_IDS.has(diagnostic.rule)) {
		return diagnostic.rule;
	}
	if (diagnostic.tool && FACT_RULE_IDS.has(diagnostic.tool)) {
		return diagnostic.tool;
	}
	if (diagnostic.id) {
		const prefix = diagnostic.id.split(":", 1)[0];
		if (FACT_RULE_IDS.has(prefix)) {
			return prefix;
		}
	}
	return undefined;
}

function trackSessionSlopStats(
	ctx: ReturnType<typeof createDispatchContext>,
	diagnostics: DispatchResult["diagnostics"],
): void {
	const lineCount = ctx.facts.getFileFact<number>(
		ctx.filePath,
		"file.lineCount",
	);
	if (
		typeof lineCount === "number" &&
		Number.isFinite(lineCount) &&
		lineCount > 0
	) {
		sessionWrittenLineCount += lineCount;
	}

	for (const diagnostic of diagnostics) {
		const ruleId = detectFactRuleId(diagnostic);
		if (!ruleId) continue;
		sessionSlopDiagnosticCount += 1;
		sessionSlopRuleCounts.set(
			ruleId,
			(sessionSlopRuleCounts.get(ruleId) ?? 0) + 1,
		);
	}
}

export function getDispatchSlopScoreSummary(): SlopScoreSummary | undefined {
	if (sessionSlopDiagnosticCount === 0 || sessionWrittenLineCount <= 0) {
		return undefined;
	}

	const totalKlocWritten = sessionWrittenLineCount / 1000;
	const ruleCounts = [...sessionSlopRuleCounts.entries()]
		.map(([ruleId, count]) => ({ ruleId, count }))
		.sort((a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId));

	return {
		totalRuleDiagnostics: sessionSlopDiagnosticCount,
		totalKlocWritten,
		scorePerKloc: sessionSlopDiagnosticCount / totalKlocWritten,
		ruleCounts,
	};
}

export function getDispatchSlopScoreLine(): string {
	const summary = getDispatchSlopScoreSummary();
	if (!summary) return "";
	return formatSlopScoreSummary(summary);
}

// SpotBugs analyzes JVM bytecode, so it applies to java + kotlin. Opt-in
// (lens-spotbugs flag) and only when a Java build descriptor + compiled .class
// dir exist — the runner itself mtime-caches so it doesn't re-run per keystroke. #133
const SPOTBUGS_SUPPORTED_KINDS = new Set<FileKind>(["java", "kotlin"]);

function withSpotbugsGroup(
	kind: FileKind,
	groups: RunnerGroup[],
	ctx: ReturnType<typeof createDispatchContext>,
): RunnerGroup[] {
	if (!SPOTBUGS_SUPPORTED_KINDS.has(kind)) return groups;
	if (!ctx.pi.getFlag("lens-spotbugs")) return groups;
	if (!hasJavaBuildDescriptor(ctx.cwd) || !findCompiledClassesDir(ctx.cwd)) {
		return groups;
	}
	if (groups.some((group) => group.runnerIds.includes("spotbugs")))
		return groups;
	return [
		...groups,
		{
			mode: "all",
			runnerIds: ["spotbugs"],
			filterKinds: [kind],
			semantic: "warning",
		},
	];
}

function withPrimaryPolicyGroup(
	kind: keyof typeof TOOL_PLANS,
	groups: RunnerGroup[],
	pi: PiAgentAPI,
): RunnerGroup[] {
	const lspEnabled = !pi.getFlag("no-lsp");
	const normalizedGroups = lspEnabled
		? groups
		: groups
				.map((group) => {
					const runnerIds = group.runnerIds.filter((id) => id !== "lsp");
					if (runnerIds.length === 0) return null;
					return {
						...group,
						runnerIds,
					};
				})
				.filter((group): group is RunnerGroup => group !== null);

	const primary = getPrimaryDispatchGroup(kind as FileKind, lspEnabled);
	if (!primary) return normalizedGroups;

	const alreadyHasPrimary = normalizedGroups.some((group) => {
		if (group.mode !== primary.mode) return false;
		if (group.runnerIds.length !== primary.runnerIds.length) return false;
		return group.runnerIds.every(
			(id, index) => primary.runnerIds[index] === id,
		);
	});
	if (alreadyHasPrimary) return normalizedGroups;

	return [primary, ...normalizedGroups];
}

export function getDispatchGroupsForKind(
	kind: keyof typeof TOOL_PLANS,
	pi: PiAgentAPI,
): RunnerGroup[] {
	const plan = TOOL_PLANS[kind];
	if (!plan) {
		const lspEnabled = !pi.getFlag("no-lsp");
		const policyGroup = getPrimaryDispatchGroup(kind as FileKind, lspEnabled);
		if (policyGroup) return [policyGroup];
		if (lspEnabled && LSP_CAPABLE_KINDS.has(kind as FileKind)) {
			return [
				{ mode: "all", runnerIds: ["lsp"], filterKinds: [kind as FileKind] },
			];
		}
		return [];
	}
	return withPrimaryPolicyGroup(kind, plan.groups, pi);
}

/**
 * Reset baselines — call on session_start so a new session
 * starts with a clean slate.
 *
 * Pass `cwd` to also re-apply the project's `.pi-lens.json` rule thresholds
 * (a no-op when the file is absent or unchanged, since the loader is
 * mtime-cached). Optional for backward compatibility with tests that don't
 * care about per-project thresholds.
 */
export function resetDispatchBaselines(cwd?: string): void {
	if (cwd) applyProjectLensConfig(cwd);
	sessionFacts.clearAll();
	resetSessionSlopScore();
	clearCoverageNoticeState();
	clearReviewGraphWorkspaceCache();
	clearReverseDepsIndexCache();
	clearModuleGraphCache();
	neighborTouchCache.clear();
	recentlyCleanNeighborCache.clear();
	primaryFilesThisTurn.clear();
	cascadeDiagnosticBaselines.clear();
	cascadeSessionStats = {
		runs: 0,
		diagnosticsSurfaced: 0,
		coldSnapshotTouches: 0,
	};
	for (const timer of astGrepWarnDebounceTimers.values()) clearTimeout(timer);
	astGrepWarnDebounceTimers.clear();
}

let cascadeSessionStats = {
	runs: 0,
	diagnosticsSurfaced: 0,
	coldSnapshotTouches: 0,
};

export function getCascadeSessionStats(): {
	runs: number;
	diagnosticsSurfaced: number;
	coldSnapshotTouches: number;
} {
	return { ...cascadeSessionStats };
}

// A5: per-turn neighbor-touch cache keyed by normalized path.
// Avoids re-touching the same neighbor on every write in a multi-file refactor.
// Invalidated when writeSeq advances (i.e. a new write starts a new pipeline run).
type NeighborCacheEntry = {
	turnSeq: number;
	writeSeq: number;
	diagnostics: import("./types.js").Diagnostic[];
};
const neighborTouchCache = new Map<string, NeighborCacheEntry>();

// Cross-turn clean cache: neighbor touches that recently returned no errors can
// be skipped for a few turns. LSP servers push diagnostics proactively when a
// file becomes unhealthy, so repeatedly re-opening known-clean neighbors is low value.
type RecentlyCleanNeighborEntry = { turnSeq: number; checkedAt: number };
const recentlyCleanNeighborCache = new Map<
	string,
	RecentlyCleanNeighborEntry
>();

/** O(1) entry counts of this module's turn-bounded caches (#1123 item 2
 *  memory attribution) — both are `Map.size` reads, never iterated. */
export function getDispatchCascadeCacheStats(): {
	neighborTouchCacheSize: number;
	recentlyCleanNeighborCacheSize: number;
} {
	return {
		neighborTouchCacheSize: neighborTouchCache.size,
		recentlyCleanNeighborCacheSize: recentlyCleanNeighborCache.size,
	};
}
const RECENTLY_CLEAN_TTL_TURNS = 5;

// B10: tracks files that were the *primary* edited file this turn.
// These are excluded from cascade neighbor results — their own pipeline run
// already reported their diagnostics authoritatively.
let cascadeTurnScope = 0;
const primaryFilesThisTurn = new Set<string>();

function ensureCascadeTurnScope(turnSeq: number): void {
	if (turnSeq === cascadeTurnScope) return;
	cascadeTurnScope = turnSeq;
	primaryFilesThisTurn.clear();
	neighborTouchCache.clear();
	for (const [key, entry] of recentlyCleanNeighborCache) {
		if (turnSeq - entry.turnSeq > RECENTLY_CLEAN_TTL_TURNS) {
			recentlyCleanNeighborCache.delete(key);
		}
	}
}

const CASCADE_TTL_MS = 240_000;
const MAX_PER_FILE = RUNTIME_CONFIG.pipeline.cascadeMaxDiagnosticsPerFile;
const MAX_FILES = RUNTIME_CONFIG.pipeline.cascadeMaxFiles;

/**
 * The genuine language-server ERROR diagnostics from a cascade neighbor
 * re-check, ready to reconcile into the footer widget (#1093).
 *
 * Drops any diagnostic whose `source` matches an auxiliary-LSP profile
 * (opengrep/ast-grep/zizmor/typos — `findAuxiliaryProfileForSource`). The
 * cascade's `convertLspDiagnostics` tags everything `tool: "lsp"`,
 * `semantic: "blocking"` and — unlike every OTHER widget writer
 * (`runners/lsp.ts`, `tools/lsp-diagnostics.ts`, `tools/lens-diagnostics.ts`) —
 * never runs `retagAuxiliaryDiagnostics`. Since `getAllDiagnostics` /
 * `touchFile({clientScope:"all"})` include the auxiliary servers' findings,
 * writing them here would (a) DOUBLE-COUNT a neighbor's own correctly-tagged aux
 * entry and (b) ESCALATE an advisory/suppressed aux finding into a blocking
 * `tool:"lsp"` error, bypassing aux policy (semantic downgrade, native
 * `# nosemgrep`/`zizmor:ignore` suppression, `skipTestFiles`). Aux findings are
 * per-file lint/security signals the neighbor's OWN per-edit runners own; they
 * are not cross-file impact, so the cascade simply excludes them and the merge
 * (`reconcileCascadeNeighborLspErrors`) preserves the neighbor's existing aux
 * entries untouched. This keeps `isLspErrorEntry`'s "tool === 'lsp' uniquely
 * identifies a genuine language-server entry" contract true for what we write.
 *
 * The DISPLAY list (`diags` at each call site) is deliberately left as-is —
 * that is pre-existing cascade output behavior, out of scope for #1093.
 */
function cascadeReconcilableLspErrors(
	rawDiags: readonly import("../lsp/client.js").LSPDiagnostic[],
	neighborPath: string,
): ReturnType<typeof convertLspDiagnostics> {
	return convertLspDiagnostics(
		rawDiags
			.filter(
				(d) => d.severity === 1 && !findAuxiliaryProfileForSource(d.source),
			)
			.slice(0, MAX_PER_FILE),
		neighborPath,
	);
}

/**
 * Read the content `binding` verdict off a raw diagnostics result (#1095).
 *
 * Both `touchFile` and `getAllDiagnostics` attach `binding` as a NON-enumerable
 * property (the latter as a lazy, disk-verifying getter). Reading it directly off
 * the producer's own object — never a spread/clone, which drops non-enumerables —
 * triggers the disk verify exactly once (memoized per result object). Returns
 * `undefined` when no binding was attached at all (a partially-mocked client, a
 * non-collecting touch) — indistinguishable from "unknown" at every call site,
 * which is the intended pre-#1095 fall-through.
 */
function readBoundToCurrentDisk(
	rawDiags: unknown,
): BoundToCurrentDisk | undefined {
	return (rawDiags as { binding?: { boundToCurrentDisk?: BoundToCurrentDisk } })
		?.binding?.boundToCurrentDisk;
}

/**
 * #1095: is this active-touch result a CONFIRMED observation of the neighbor's
 * current on-disk LSP-error state — safe to reconcile into the footer widget and
 * (when clean) to seed the recently-clean neighbor cache?
 *
 * Composes the two independent disqualifiers into ONE clearly-named predicate so
 * a future flag cannot be silently missed at just one of the several gate sites:
 *  - `inconclusive` (#1093/#571): the notify/diagnostics wait lapsed its deadline,
 *    so a resolved `[]` is NOT a confirmed clean (the #533 false-clean trap).
 *  - `binding.boundToCurrentDisk === false` (#1095): the diagnostics were computed
 *    against a DIFFERENT disk state than what is on disk now (the server's view
 *    diverged / a pre-fix buffer) — not an observation of current disk. `true` and
 *    `"unknown"` both pass; `"unknown"` preserves pre-#1095 behavior for a
 *    version-less server exactly.
 *
 * Both flags are non-enumerable on the `touchFile` result — read them directly off
 * `rawDiags`, never off a spread/clone (which drops them). See the memo-freeze note
 * at the `getAllDiagnostics` call site.
 */
function readInconclusive(rawDiags: unknown): boolean {
	return (rawDiags as { inconclusive?: boolean })?.inconclusive === true;
}

function isConfirmedTouch(
	rawDiags: readonly import("../lsp/client.js").LSPDiagnostic[],
): boolean {
	return !readInconclusive(rawDiags) && readBoundToCurrentDisk(rawDiags) !== false;
}

// #459: the reverse-dependency index is a pure function of the review graph.
// Rebuilding it (O(graph edges)) and re-writing it to the project snapshot
// (disk write) on every cascade run is wasted work whenever the graph build
// was a cache hit. Keyed per-workspace (normalized cwd — same key shape as
// builder.ts's _workspaceGraphCache) so unrelated workspaces never share or
// clobber each other's cached index. Freshness is keyed on the generation
// stamp the entry's index was built from (ReviewGraph.buildGeneration).
type ReverseDepsCacheEntry = {
	index: ReverseDependencyIndex;
	savedToSnapshot: boolean;
	/** buildGeneration of the graph this index was derived from. */
	generation: number | undefined;
};
const reverseDepsIndexCache = new Map<string, ReverseDepsCacheEntry>();

function reverseDepsReuseEnabled(): boolean {
	const raw = process.env.PI_LENS_REVERSE_DEPS_REUSE;
	return raw !== "0" && raw !== "false";
}

/** Test-reset hook — mirrors clearReviewGraphWorkspaceCache's scope. */
export function clearReverseDepsIndexCache(): void {
	reverseDepsIndexCache.clear();
}

// Bounded transitive cascade (#162): expand neighbour derivation beyond the
// one-hop importers/callers to depth-2 dependents, so an edit's blast radius
// reaches indirect dependents — capped so the per-edit cost stays bounded. The
// one-hop set is always the floor (it sorts first, before depth-2). Both
// env-tunable; set depth to 1 to restore the old one-hop-only behaviour.
const CASCADE_TRANSITIVE_DEPTH = Math.max(
	1,
	Number.parseInt(process.env.PI_LENS_CASCADE_TRANSITIVE_DEPTH ?? "2", 10) || 2,
);
const CASCADE_NEIGHBOUR_BUDGET = Math.max(
	MAX_FILES,
	Number.parseInt(process.env.PI_LENS_CASCADE_NEIGHBOUR_BUDGET ?? "40", 10) ||
		40,
);
// Exported (not just module-local) so the MCP warm-analyze seam
// (clients/mcp/analyze.ts, #536) can gate its own buildOrUpdateGraph call on
// the SAME file-kind eligibility this cascade path uses — one source of truth
// for "does this language get graph nodes at all", never a second hardcoded copy.
export const CASCADE_GRAPH_KINDS = new Set([
	"jsts",
	"python",
	"go",
	"rust",
	"ruby",
	"cxx",
]);

/**
 * Unified cascade orchestration — builds graph, discovers neighbors, and
 * gathers per-file diagnostics with structured logging to cascade.log.
 *
 * autoPropagate (jsts): tsserver pushes diagnostics automatically, so we
 * read from the passive snapshot instead of touching neighbors actively.
 *
 * Degraded fallback: when the graph produces no neighbors (ungraphed languages
 * like Java/Kotlin/C#), fall back to the passive LSP snapshot from getAllDiagnostics
 * to preserve cascade coverage.
 */
/**
 * Whether a cascade neighbour is suppressed by the project's ignore config
 * (`.pi-lens.json` / `.gitignore` / global `~/.pi-lens/config.json`), via the
 * same `getProjectIgnoreMatcher` every other scan surface uses. Cascade surfaces
 * collateral diagnostics in OTHER files an edit touched; a file the user ignores
 * (e.g. a `*.test.ts` glob in `.pi-lens.json`) must not be re-surfaced here just
 * because it imports the edited file — project walk and lens_diagnostics already
 * filter it, and cascade was the last surface that didn't (#297). Fail-open: a
 * config-probe error never drops a neighbour, matching the walkers' behaviour.
 */
function isIgnoredCascadeNeighbor(filePath: string, cwd: string): boolean {
	try {
		return getProjectIgnoreMatcher(cwd).isIgnored(filePath, false);
	} catch {
		return false;
	}
}

/**
 * #348 phase 2 per-edit seam: update the warm in-memory word index for one
 * file, mirroring the review graph's per-edit rebuild at the same call site.
 *
 * Rules (each a documented, deliberate simplicity choice, not an oversight):
 *  - `wordIndex` null (no index loaded yet) ⇒ no-op. Cold-session handoff is
 *    OWNED by phase 1's lifecycle/background build, never invented here — an
 *    edit arriving before that build finishes just doesn't update anything;
 *    the eventual full build already reflects every file on disk, incl. this
 *    edit, so nothing is lost, only delayed.
 *  - `wordIndex.forward` undefined (pre-phase-2 index shape, e.g. a snapshot
 *    persisted before this feature or one still using the old serialized
 *    shape) ⇒ no-op. `updateWordIndexDocument` already refuses to mutate a
 *    forward-index-less index (see its doc comment) — this is the same rule
 *    surfaced one layer up so the caller isn't left guessing why nothing
 *    happened. The NEXT full rebuild (session-start lifecycle) installs a
 *    forward-index-bearing index that later edits CAN update incrementally.
 *  - `content` undefined (pipeline couldn't read the file — deleted, or a
 *    transient race) ⇒ no-op. Deletions aren't plumbed at this seam (this
 *    call site only ever sees the edited file's post-write content, never a
 *    delete event) — a removed file ages out at the next full rebuild, same
 *    scope boundary the review graph accepts for deletes.
 *  - File over the shared `WORD_INDEX_MAX_BYTES` cap ⇒ removed/absent from
 *    the index (never partially indexed) — same cap phase 1's build path
 *    enforces via `collectWordIndexDocs`.
 *  - On a successful update, `onUpdated` fires so the caller can schedule a
 *    debounced persist (never a synchronous write per edit — same #260
 *    discipline as the graph).
 *
 * Race safety against a build-in-progress: this function body is entirely
 * synchronous (no `await` anywhere in it) and is called synchronously at
 * `computeCascadeForFile`'s entry, before its own `await buildOrUpdateGraph`.
 * Node is single-threaded, so two overlapping cascades (#450's unawaited
 * concurrency) can never interleave mid-mutation here — each call runs to
 * completion in one turn. The only cross-build hazard is a full session-start
 * rebuild REPLACING `runtime.wordIndex` with a new object between the caller
 * reading `runtime.wordIndex` (in runtime-tool-result.ts, also synchronous)
 * and this function receiving it — in that case this call simply mutates
 * whichever index object it was handed (old or new), and the other one is
 * abandoned/superseded, never corrupted. No queue, no lock: the simplest rule
 * that is still provably correct.
 */
function updateWordIndexForCascade(args: {
	wordIndex?: WordIndex | null;
	filePath: string;
	content?: string;
	onUpdated?: (index: WordIndex) => void;
	dbg?: (msg: string) => void;
}): void {
	const { wordIndex, filePath, content, onUpdated, dbg } = args;
	if (!wordIndex || !wordIndex.forward) return;
	if (content === undefined) return;

	const byteLength = Buffer.byteLength(content, "utf-8");
	if (byteLength > WORD_INDEX_MAX_BYTES) {
		removeWordIndexDocument(wordIndex, filePath);
		dbg?.(`word-index per-edit: dropped ${filePath} (over size cap)`);
	} else {
		updateWordIndexDocument(wordIndex, { path: filePath, content });
		dbg?.(`word-index per-edit: updated ${filePath}`);
	}
	onUpdated?.(wordIndex);
}

export async function computeCascadeForFile(
	filePath: string,
	cwd: string,
	options: {
		hasBlockers?: boolean;
		dbg?: (msg: string) => void;
		/** Turn/write sequence from RuntimeCoordinator — scopes cascade caches (A5/B10) */
		turnSeq?: number;
		writeSeq?: number;
		/**
		 * RuntimeCoordinator sequence state (#451). When present, the graph build
		 * below can take the seq fast path and skip the O(project) walk+stat sweep.
		 * `projectSeq` is read at build time (deferred cascade, #450).
		 */
		seqState?: {
			projectSeq: () => number;
			getFilesChangedSince: (seq: number) => string[];
		};
		/**
		 * Post-format/post-fix file content, already read by the pipeline before
		 * this deferred cascade runs (#348 phase 2). Reused here to update the
		 * warm in-memory word index at the SAME seam as the graph rebuild below —
		 * no extra I/O path, just one file's tokenization. `undefined` when the
		 * pipeline couldn't read the file (deleted, race) — the word-index update
		 * is skipped in that case.
		 */
		fileContent?: string;
		/**
		 * Live reference to `runtime.wordIndex` (#348 phase 2). `null` means no
		 * index is loaded in memory yet — the per-edit path is then a documented
		 * no-op (cold handoff): phase 1's lifecycle/background build owns "cold",
		 * never this seam. A non-null index with no `forward` map (pre-phase-2 /
		 * deserialized from an old snapshot) is also a no-op — the caller's next
		 * full rebuild installs a forward-index-bearing index that later edits
		 * CAN update incrementally.
		 */
		wordIndex?: WordIndex | null;
		/** Debounced-persist hook for the updated word index (#348 phase 2). */
		onWordIndexUpdated?: (index: WordIndex) => void;
	} = {},
): Promise<CascadeRun> {
	const {
		hasBlockers = false,
		dbg,
		turnSeq = 0,
		writeSeq,
		seqState,
		fileContent,
		wordIndex,
		onWordIndexUpdated,
	} = options;

	ensureCascadeTurnScope(turnSeq);

	if (hasBlockers) {
		logCascade({
			phase: "cascade_skip",
			filePath,
			reason: "primary_has_blockers",
		});
		return {
			filePath,
			result: undefined,
			neighborCount: 0,
			diagnosticCount: 0,
			skipReason: "blockers" as CascadeSkipReason,
		};
	}

	const fileKind = detectFileKind(filePath);
	if (!fileKind) {
		logCascade({ phase: "cascade_skip", filePath, reason: "non_code_file" });
		return {
			filePath,
			result: undefined,
			neighborCount: 0,
			diagnosticCount: 0,
			skipReason: "non_code" as CascadeSkipReason,
		};
	}

	const normalizedFile = resolveRunnerPath(cwd, filePath);
	const normalizedFileKey = normalizeMapKey(normalizedFile);

	// B10: record this file as a primary edit so later cascade calls in the same
	// turn won't show it as a neighbor.
	primaryFilesThisTurn.add(normalizedFileKey);

	// #348 phase 2: warm per-edit word-index maintenance, review-graph style —
	// update at the SAME seam as the graph rebuild below, using content the
	// pipeline already read (no extra I/O). See computeCascadeForFile's
	// `wordIndex`/`fileContent` doc comments for the cold/no-forward-index
	// no-op rules.
	//
	// Keyed by `path.resolve(filePath)` (native separators, tool-input casing).
	// Since #1025 the word index's path maps are `PathKeyedMap`s that fold every
	// key through `wordIndexKey` (`normalizeEphemeralMapKey` — slash-fold +
	// win32-lowercase) INTERNALLY, so this per-edit key and the build path's own
	// walk-derived key (`collectWordIndexDocs` → `collectSourceFilesAsync`)
	// collapse to the same entry regardless of on-disk-vs-input casing/separator.
	// The old hazard — this update silently orphaning a SECOND entry next to the
	// walker's original-cased one — is now structurally impossible at the map
	// layer, so this seam no longer has to hand-match the build path's key shape.
	updateWordIndexForCascade({
		wordIndex,
		filePath: nodePath.resolve(filePath),
		content: fileContent,
		onUpdated: onWordIndexUpdated,
		dbg,
	});

	let impact: ReturnType<typeof computeImpactCascade> = {
		filePath: normalizedFile,
		changedSymbols: [],
		directImporters: [],
		directCallers: [],
		neighborFiles: [],
		riskFlags: [],
	};
	let sortedNeighbors: string[] = [];
	let importerSet = new Set<string>();
	let callerSet = new Set<string>();
	let referenceCount = 0;

	if (CASCADE_GRAPH_KINDS.has(fileKind)) {
		const graphStart = Date.now();
		const graph = await buildOrUpdateGraph(
			cwd,
			[normalizedFile],
			sessionFacts,
			seqState,
		);
		const graphMs = Date.now() - graphStart;
		// #459: the reuse decision keys on graph.buildGeneration — a stamp that
		// travels WITH the graph instance this cascade holds. Deliberately NOT the
		// global last-build-info slot: post-#450 cascades overlap, and another
		// cascade's cache-hit build can overwrite that slot (graphChanged:false)
		// between this build mutating the graph and this read — which would turn a
		// changed graph into a spurious reuse of a stale index that steady-state
		// cache hits then never heal. Generation equality can't be clobbered into
		// a false positive: a graph-mutating build always mints a new generation.
		// An unstamped graph (mode "skipped") always rebuilds.
		const graphBuildInfo = getGraphBuildInfoForGraph(graph);
		const workspaceKey = normalizeMapKey(cwd);
		const cachedReverseDeps = reverseDepsIndexCache.get(workspaceKey);
		const importDelta = getGraphImportChanges(graph);
		// A one-step delta is only usable against an index cached at exactly the
		// delta's predecessor generation. Builds minted elsewhere (mcp analyze,
		// lens-map, session warm) advance generations whose import changes this
		// delta does not cover — reusing/patching across that gap stamps a stale
		// index as current, and generation equality then hides the loss forever
		// (#939 review finding 1).
		const deltaContiguous =
			importDelta !== undefined &&
			importDelta.fromGeneration !== undefined &&
			cachedReverseDeps !== undefined &&
			cachedReverseDeps.generation === importDelta.fromGeneration;
		const importChanges = deltaContiguous ? importDelta.changes : undefined;
		const importsChanged = importChanges?.some(
			(change) =>
				change.existedBefore !== change.existsAfter ||
				change.priorTargets.length !== change.newTargets.length ||
				change.priorTargets.some(
					(target, index) => target !== change.newTargets[index],
				),
		);
		const canReuse =
			reverseDepsReuseEnabled() &&
			cachedReverseDeps !== undefined &&
			((graph.buildGeneration !== undefined &&
				cachedReverseDeps.generation === graph.buildGeneration) ||
				(importChanges !== undefined && !importsChanged));

		let reverseDepsIndex: ReverseDependencyIndex;
		let reverseDepsSaved: boolean;
		if (canReuse && cachedReverseDeps) {
			reverseDepsIndex = cachedReverseDeps.index;
			reverseDepsSaved = cachedReverseDeps.savedToSnapshot;
			cachedReverseDeps.generation = graph.buildGeneration;
			logCascade({
				phase: "reverse_deps_cache",
				filePath,
				durationMs: Date.now() - graphStart,
				metadata: {
					action: "reused_unchanged",
					savedToSnapshot: reverseDepsSaved,
					importsFileCount: Object.keys(reverseDepsIndex.imports).length,
					importedByFileCount: Object.keys(reverseDepsIndex.importedBy).length,
				},
			});
		} else if (cachedReverseDeps && importChanges && importsChanged) {
			reverseDepsIndex = patchReverseDependencyIndex(
				cachedReverseDeps.index,
				importChanges,
			);
			reverseDepsSaved = writeReverseDependencyIndexToSnapshot({
				cwd,
				index: reverseDepsIndex,
				dbg,
			});
			reverseDepsIndexCache.set(workspaceKey, {
				index: reverseDepsIndex,
				savedToSnapshot: reverseDepsSaved,
				generation: graph.buildGeneration,
			});
			logCascade({
				phase: "reverse_deps_cache",
				filePath,
				durationMs: Date.now() - graphStart,
				metadata: {
					action: "patched_import_changes",
					changedFileCount: importChanges.length,
					savedToSnapshot: reverseDepsSaved,
				},
			});
		} else {
			reverseDepsIndex = buildReverseDependencyIndexFromGraph({
				cwd,
				graph,
			});
			reverseDepsSaved = writeReverseDependencyIndexToSnapshot({
				cwd,
				index: reverseDepsIndex,
				dbg,
			});
			reverseDepsIndexCache.set(workspaceKey, {
				index: reverseDepsIndex,
				savedToSnapshot: reverseDepsSaved,
				generation: graph.buildGeneration,
			});
			logCascade({
				phase: "reverse_deps_cache",
				filePath,
				durationMs: Date.now() - graphStart,
				metadata: {
					action: "refresh_from_review_graph",
					savedToSnapshot: reverseDepsSaved,
					importsFileCount: Object.keys(reverseDepsIndex.imports).length,
					importedByFileCount: Object.keys(reverseDepsIndex.importedBy).length,
					importEdgeCount: Object.values(reverseDepsIndex.imports).reduce(
						(total, imports) => total + imports.length,
						0,
					),
				},
			});
		}

		// Count files represented in the graph (nodes with a filePath).
		const graphFileCount = new Set(
			[...graph.nodes.values()].flatMap((n) =>
				n.filePath ? [n.filePath] : [],
			),
		).size;

		logCascade({
			phase: "graph_build",
			filePath,
			graphBuiltMs: graphMs,
			graphReused: graphBuildInfo.reused,
			graphNodeCount: graph.nodes.size,
			graphFileCount,
			graphChangedSymbolCount: (
				graph.changedSymbolsByFile.get(normalizedFileKey) ?? []
			).length,
			metadata: {
				graphBuildMode: graphBuildInfo.mode,
				skipReason: graphBuildInfo.skipReason,
				sourceFileCount: graphBuildInfo.sourceFileCount,
				maxFileCount: graphBuildInfo.maxFileCount,
				// #451: when the seq fast path fell back (or was skipped), why — so
				// cascade.log surfaces the fast-path hit/miss rate.
				seqFastpathFallback: graphBuildInfo.seqFastpathFallback,
			},
		});

		impact = computeImpactCascade(graph, normalizedFile, cwd);
		// #1023: buildOrUpdateGraph returns an EMPTY graph (seeded only with the
		// changed file's own symbols) when the repo is over
		// PI_LENS_REVIEW_GRAPH_MAX_FILES (`too_many_files`) or the root is unsafe
		// (`unsafe_root`) — both stamp mode "skipped" on the already-read
		// graphBuildInfo. A capped or entry-budget-truncated graph is also not a
		// complete dependent set even though it has nodes, so it must not look like
		// a clean leaf. Thread the ALREADY-KNOWN degraded state (never re-derived)
		// onto the result so the turn-end seam surfaces an honest advisory instead
		// of a silent all-clear (#533). Keyed strictly off the graph's explicit
		// degraded marker, NOT off `neighborFiles.length === 0`.
		if (
			(graphBuildInfo.mode === "skipped" ||
				graph.persistCoverage?.partial === true) &&
			!impact.indeterminate
		) {
			const coverage = graph.persistCoverage;
			impact.indeterminate = {
				reason: "graph_degraded",
				detail:
					graphBuildInfo.mode === "skipped"
						? graphBuildInfo.skipReason === "too_many_files"
							? `review graph disabled — ${graphBuildInfo.sourceFileCount ?? "?"} files over the ${graphBuildInfo.maxFileCount ?? "?"} cap`
							: graphBuildInfo.skipReason === "unsafe_root"
								? "review graph skipped — workspace root is at/above home dir"
								: `review graph unavailable (${graphBuildInfo.skipReason ?? "skipped"})`
						: coverage?.sourceFilesTruncated
							? "review graph partial — source walk stopped at its visited-entry budget"
							: "review graph partial — persisted graph coverage is incomplete",
				sourceFileCount: graphBuildInfo.sourceFileCount,
				maxFileCount: graphBuildInfo.maxFileCount,
			};
		}
		const reverseDepNeighbors = getAffectedFilesFromIndex(
			reverseDepsIndex,
			normalizedFile,
			1,
			MAX_FILES * 2,
		);
		logCascade({
			phase: "reverse_deps_cache",
			filePath,
			metadata: {
				action: "merge_neighbors",
				depth: 1,
				neighborCount: reverseDepNeighbors.length,
				neighbors: reverseDepNeighbors.slice(0, 10),
			},
		});
		if (reverseDepNeighbors.length > 0) {
			impact.directImporters = [
				...new Set([...impact.directImporters, ...reverseDepNeighbors]),
			];
			impact.neighborFiles = [
				...new Set([...impact.neighborFiles, ...reverseDepNeighbors]),
			];
			logCascade({
				phase: "neighbor_snapshot",
				filePath,
				neighborFile: "[reverse-deps-cache]",
				diagnosticCount: reverseDepNeighbors.length,
				autoPropagate: false,
				metadata: { reverseDepsCache: true },
			});
		}

		// Symbol-level blast radius via LSP references (precision upgrade over
		// file-level import edges). Only when changed symbols are detected.
		// Keep the budget tight: 750ms per symbol, 1200ms total, max 3 symbols.
		if (impact.changedSymbols.length > 0) {
			const lspService = getLSPService();
			const symbolNodeIds =
				graph.symbolNodesByFile.get(normalizedFileKey) ?? [];
			const refFiles = new Set<string>();
			const refsStart = Date.now();
			for (const symbolName of impact.changedSymbols.slice(0, 3)) {
				const symbolNodeId = symbolNodeIds.find((id) => {
					const node = graph.nodes.get(id);
					return node?.symbolName === symbolName;
				});
				if (!symbolNodeId) continue;
				const node = graph.nodes.get(symbolNodeId);
				const line = Number(node?.metadata?.line ?? 0);
				const column = Number(node?.metadata?.column ?? 0);
				if (line <= 0) continue;
				// #1109: store the timer and clear it once the race settles. Without
				// this, when `references()` wins (the common case), the losing
				// `setTimeout` stays a REF'D pending timer for the remaining 750ms —
				// harmless in a long-lived session, but a keep-alive tail in a
				// one-shot `pi --print` process (same uncleared-race-timeout class
				// fixed for the LSP client-wait leak in clients/lsp/index.ts, #1097).
				let refsTimer: ReturnType<typeof setTimeout> | undefined;
				try {
					const refs = await Promise.race([
						lspService.references(normalizedFile, line - 1, column - 1, false),
						new Promise<never>((_, reject) => {
							refsTimer = setTimeout(() => reject(new Error("timeout")), 750);
						}),
					]);
					for (const ref of refs) {
						let resolved: string;
						try {
							resolved = ref.uri.startsWith("file://")
								? fileURLToPath(ref.uri)
								: ref.uri;
						} catch {
							continue;
						}
						if (
							normalizeMapKey(resolved) !== normalizedFileKey &&
							nodeFs.existsSync(resolved)
						) {
							refFiles.add(normalizeMapKey(resolved));
						}
					}
				} catch {
					// Timeout or LSP error — fall back to import-graph neighbors
				} finally {
					if (refsTimer) clearTimeout(refsTimer);
				}
				if (Date.now() - refsStart > 1200) break; // Hard ceiling
			}
			if (refFiles.size > 0) {
				impact.neighborFiles = [
					...new Set([...impact.neighborFiles, ...refFiles]),
				];
				logCascade({
					phase: "neighbor_snapshot",
					filePath,
					neighborFile: "[lsp-references]",
					diagnosticCount: refFiles.size,
					durationMs: Date.now() - refsStart,
					autoPropagate: false,
					metadata: { lspReferences: true },
				});
			}
		}

		// Bounded transitive expansion: add depth>1 dependents (indirect
		// importers/callers/referencers) so the blast radius isn't limited to one
		// hop. The one-hop sets above remain the floor (they sort first); these
		// fill the remaining budget. Graph BFS is in-memory + capped.
		if (CASCADE_TRANSITIVE_DEPTH > 1) {
			const transitive = computeTransitiveImpact(graph, normalizedFile, {
				maxDepth: CASCADE_TRANSITIVE_DEPTH,
				maxHits: CASCADE_NEIGHBOUR_BUDGET,
			});
			const added = [
				...new Set(
					transitive.hits
						.map((hit) => hit.file)
						.filter(
							(file) => file && normalizeMapKey(file) !== normalizedFileKey,
						),
				),
			].filter((file) => !impact.neighborFiles.includes(file));
			if (added.length > 0) {
				impact.neighborFiles = [...impact.neighborFiles, ...added];
				logCascade({
					phase: "neighbor_snapshot",
					filePath,
					neighborFile: "[transitive-impact]",
					diagnosticCount: added.length,
					autoPropagate: false,
					metadata: {
						transitive: true,
						maxDepth: CASCADE_TRANSITIVE_DEPTH,
						maxDepthReached: transitive.maxDepthReached,
						truncated: transitive.truncated,
					},
				});
			}
		}

		// #1080: exclude KNOWN test-role files from every collateral impact
		// surface — the formatted header (formatImpactCascade reads `impact`
		// directly for `Direct importers`/`Direct callers`/`Check next` counts and
		// names), the active-touch/passive-snapshot neighbor set (sortedNeighbors is
		// derived from `impact.neighborFiles` below), and the returned `impact`
		// object. Applied HERE — after graph neighbors, reverse-deps, LSP reference
		// expansion, and transitive expansion have all been merged in — so it covers
		// every neighbor source (incl. module-level downstream files that entered via
		// computeImpactCascade and reference URIs pointing at `*.test.*`). Filtering
		// upstream of `sortedNeighbors` also means a test URI is never actively
		// touched solely for cascade diagnostics. Composes the shared `detectFileRole`
		// seam; a classifier failure RETAINS the candidate (honest — never a false
		// clean). The project ignore filter below is separate and unchanged (#297).
		impact.directImporters = impact.directImporters.filter(
			(f) => !isTestRoleCollateral(f),
		);
		impact.directCallers = impact.directCallers.filter(
			(f) => !isTestRoleCollateral(f),
		);
		impact.neighborFiles = impact.neighborFiles.filter(
			(f) => !isTestRoleCollateral(f),
		);

		// Sort by relationship strength (B6) then cap to the neighbour budget.
		// directImporters are most impactful, then callers, then reference edges.
		importerSet = new Set(impact.directImporters);
		callerSet = new Set(impact.directCallers);
		// neighbors that are neither direct importers nor callers are reference-edge neighbors
		const importerOrCallerSet = new Set([
			...impact.directImporters,
			...impact.directCallers,
		]);
		referenceCount = impact.neighborFiles.filter(
			(n) => !importerOrCallerSet.has(n),
		).length;
		sortedNeighbors = [...impact.neighborFiles]
			.filter((n) => nodeFs.existsSync(n))
			.filter((n) => !isExternalOrVendorFile(n, cwd))
			// Honour the project's ignore config: a user-ignored neighbour (e.g.
			// `**/*.test.ts`) must not surface as collateral cascade noise (#297).
			.filter((n) => !isIgnoredCascadeNeighbor(n, cwd))
			// B10: exclude files already edited as primary this turn — their own pipeline
			// run is the authoritative diagnostic source; showing them as neighbors is noise.
			.filter((n) => !primaryFilesThisTurn.has(normalizeMapKey(n)))
			.sort((a, b) => {
				const rank = (p: string) =>
					importerSet.has(p) ? 0 : callerSet.has(p) ? 1 : 2;
				return rank(a) - rank(b);
			})
			.slice(0, CASCADE_NEIGHBOUR_BUDGET);
	} else {
		logCascade({
			phase: "cascade_skip",
			filePath,
			reason: "unsupported_graph_kind",
			metadata: { fileKind },
		});
		return {
			filePath,
			result: undefined,
			neighborCount: 0,
			diagnosticCount: 0,
			skipReason: "non_code" as CascadeSkipReason,
		};
	}

	logCascade({
		phase: "neighbors_computed",
		filePath,
		neighborCount: sortedNeighbors.length,
		totalNeighborCount: impact.neighborFiles.length,
		importerCount: impact.directImporters.length,
		callerCount: impact.directCallers.length,
		referenceCount: Math.max(0, referenceCount),
		riskFlags: impact.riskFlags,
		metadata: { neighbors: sortedNeighbors.slice(0, 10) },
	});

	const lspService = getLSPService();

	// Hoist passive snapshot once — used for auto-propagating LSPs and fallback path.
	// #1095 memo-freeze caveat: each getAllDiagnostics() result attaches `.binding`
	// as a LAZY getter that memoizes its disk verdict PER RESULT OBJECT. This cascade
	// re-calls getAllDiagnostics() every run and never retains the Map across turns,
	// so every run reads a FRESH verdict against current disk. If cross-turn retention
	// of this Map is ever introduced, the memoized binding would freeze stale — re-read
	// a fresh getAllDiagnostics() result at binding-read time instead of caching it.
	const allDiags = await lspService.getAllDiagnostics();

	const neighbors: CascadeResult["neighbors"] = [];
	let producedLspData = false;
	let coldSnapshotPaths: string[] = [];
	// #1104: did any DEGRADED-fallback display path (touch-error fallback,
	// appendFallbackNeighbors) withhold a TTL-fresh entry solely because its
	// content binding was rejected (`boundToCurrentDisk === false` — computed
	// against a diverged/pre-fix-edit disk state)? Tracked separately from
	// `producedLspData` so the HONESTY check below can tell "genuinely nothing to
	// show" apart from "something existed but was untrustworthy and was hidden" —
	// the latter must not collapse into a clean-looking result (#1104 honesty
	// rule, same doctrine as #1023's graph-degraded indeterminate marker).
	let fallbackBindingRejected = false;

	if (sortedNeighbors.length > 0) {
		const snapshotPaths = sortedNeighbors.filter(shouldReadCascadeFromSnapshot);
		const activePaths = sortedNeighbors.filter(
			(n) => !shouldReadCascadeFromSnapshot(n),
		);

		// Auto-propagating LSPs (TypeScript/Deno) — read passive snapshot with normalized key.
		// When the snapshot is valid, use it immediately (no touch needed — server already has
		// fresh data from auto-propagation). When missing or stale, fall through to the active
		// touch pool below so we get real diagnostics instead of silently returning zero.
		coldSnapshotPaths = [];
		for (const neighborPath of snapshotPaths) {
			const neighborStart = Date.now();
			const entry = allDiags.get(normalizeMapKey(neighborPath));
			const snapshotAgeSec = entry
				? Math.round((Date.now() - entry.ts) / 1000)
				: undefined;
			const ttlFresh =
				entry != null && Date.now() - entry.ts < CASCADE_TTL_MS;
			// #1095: content binding is the INNER gate; TTL stays the outer bound.
			//   false     → the server's diagnostics were computed against a DIFFERENT
			//               disk state (e.g. the PRE-fix content) — don't trust or
			//               reconcile this snapshot; fall through to an active touch on
			//               the same (cold-snapshot) budget as a TTL-stale entry. This
			//               kills the window where the first cascade after a fix-edit
			//               replays the neighbor's pre-fix snapshot.
			//   "unknown" → version-less/unreadable: keep EXACTLY the pre-#1095 TTL-only
			//               behavior (reconcile if TTL-fresh).
			//   true      → bound to current disk: reconcile (TTL still the outer bound).
			// Reading `.binding` triggers the lazy disk verify on the getAllDiagnostics
			// result — done ONLY when TTL-fresh so a doomed (stale) entry never pays the
			// stat+hash.
			const boundToDisk: BoundToCurrentDisk | undefined = ttlFresh
				? readBoundToCurrentDisk(entry)
				: undefined;
			const bindingRejected = boundToDisk === false;
			const snapshotValid = ttlFresh && !bindingRejected;

			if (!snapshotValid) {
				// No usable snapshot — queue for active touch alongside non-jsts neighbors.
				logCascade({
					phase: "neighbor_snapshot",
					filePath,
					neighborFile: neighborPath,
					diagnosticCount: 0,
					durationMs: Date.now() - neighborStart,
					autoPropagate: true,
					snapshotMissing: entry == null,
					snapshotAgeSec,
					coldSnapshot: true,
					// #1095: distinguish a binding-rejected fall-through (TTL-fresh but the
					// server's view diverged from disk) from a plain TTL-stale/missing one.
					...(bindingRejected && {
						metadata: { bindingState: bindingStateLabel(boundToDisk) },
					}),
				});
				coldSnapshotPaths.push(neighborPath);
				continue;
			}

			// #692: `source: "cascade"` used to be passed here to label `rule`
			// (`cascade:<code>`) — that override is gone (identity must come from
			// the diagnostic's own source; see `scanOrigin`'s doc comment), and
			// cascade neighbor diagnostics are ephemeral display-only output
			// (never reconciled into persisted widget/dedup state), so the label
			// had no remaining purpose and is simply dropped rather than migrated.
			const diags = convertLspDiagnostics(
				entry.diags.filter((d) => d.severity === 1).slice(0, MAX_PER_FILE),
				neighborPath,
			);
			producedLspData = true;
			const durationMs = Date.now() - neighborStart;

			logCascade({
				phase: "neighbor_snapshot",
				filePath,
				neighborFile: neighborPath,
				diagnosticCount: diags.length,
				durationMs,
				autoPropagate: true,
				snapshotMissing: false,
				snapshotAgeSec,
			});

			// #1093: a valid passive snapshot IS a confirmed observation of this
			// neighbor's current LSP-error state (#571 semantics) — reconcile it into
			// the footer widget, INCLUDING the confirmed-clean `[]` case, so a
			// fix-edit to the primary that resolves a cross-file error in this
			// neighbor clears the neighbor's now-stale footer entry (the #1092
			// defect). MERGE (genuine LSP errors only — auxiliary findings excluded,
			// see `cascadeReconcilableLspErrors`) so a live biome/ruff/aux finding or
			// LSP warning on the neighbor is preserved. Keyed by the primary edit's
			// `writeSeq` so a genuinely newer per-edit write still wins the
			// WriteOrderingGuard. `observedAt = entry.ts` (the snapshot's own publish
			// time, up to CASCADE_TTL_MS old) — NOT now() — so replaying an aging
			// snapshot never re-arms the mtime-staleness gate (the same #1092
			// re-arming defect this PR fixes for cache hits).
			//
			// #1093 known edge (P3, follow-up): this stamps the WHOLE merged record's
			// single `touchedAt` with `entry.ts`, including PRESERVED entries that may
			// have been observed more recently. If the neighbor's mtime later falls
			// between `entry.ts` and a preserved entry's real observation time,
			// `reconcileStaleWidgetFiles` drops the whole record — including those
			// newer findings. The real fix is per-entry observation timestamps, which
			// is out of scope here and folded into the structural redesign under
			// #1093.
			reconcileCascadeNeighborLspErrors(
				neighborPath,
				cascadeReconcilableLspErrors(entry.diags, neighborPath),
				writeSeq,
				entry.ts,
			);

			neighbors.push({
				filePath: neighborPath,
				reason: neighborReason(importerSet, callerSet, neighborPath),
				diagnostics: diags,
				lspTouched: false,
				durationMs,
			});
		}

		// fan-out active touches in parallel (A3):
		// - non-jsts neighbors (always touched)
		// - autoPropagate neighbors whose snapshot was missing/stale (coldSnapshotPaths)
		//   use a tighter 1000ms budget since the server is expected to be warm already.
		const touchResults = await Promise.allSettled(
			[...activePaths, ...coldSnapshotPaths].map(async (neighborPath) => {
				const isColdSnapshot = coldSnapshotPaths.includes(neighborPath);
				const neighborStart = Date.now();
				const cacheKey = normalizeMapKey(neighborPath);

				const passiveEntry = allDiags.get(cacheKey);
				const hasFreshPassiveErrors =
					passiveEntry != null &&
					Date.now() - passiveEntry.ts < CASCADE_TTL_MS &&
					passiveEntry.diags.some((d) => d.severity === 1);
				const recentlyClean = recentlyCleanNeighborCache.get(cacheKey);
				if (
					recentlyClean &&
					turnSeq - recentlyClean.turnSeq <= RECENTLY_CLEAN_TTL_TURNS &&
					!hasFreshPassiveErrors
				) {
					producedLspData = true;
					const durationMs = Date.now() - neighborStart;
					logCascade({
						phase: "neighbor_snapshot",
						filePath,
						neighborFile: neighborPath,
						diagnosticCount: 0,
						durationMs,
						autoPropagate: false,
						snapshotMissing: false,
						metadata: {
							recentlyClean: true,
							cleanTurnSeq: recentlyClean.turnSeq,
						},
					});
					return {
						filePath: neighborPath,
						reason: neighborReason(importerSet, callerSet, neighborPath),
						diagnostics: [],
						lspTouched: false,
						durationMs,
					} satisfies CascadeResult["neighbors"][number];
				}

				// A5: skip re-touch if this neighbor was already diagnosed at the current
				// write sequence. A new write (higher writeSeq) invalidates the cache entry.
				const cached =
					writeSeq != null ? neighborTouchCache.get(cacheKey) : undefined;
				if (cached?.turnSeq === turnSeq && cached?.writeSeq === writeSeq) {
					producedLspData = true;
					const durationMs = Date.now() - neighborStart;
					logCascade({
						phase: "neighbor_snapshot",
						filePath,
						neighborFile: neighborPath,
						diagnosticCount: cached.diagnostics.length,
						durationMs,
						autoPropagate: false,
						snapshotMissing: false,
						metadata: { cachedWriteSeq: writeSeq },
					});
					return {
						filePath: neighborPath,
						reason: neighborReason(importerSet, callerSet, neighborPath),
						diagnostics: cached.diagnostics,
						lspTouched: false,
						durationMs,
					} satisfies CascadeResult["neighbors"][number];
				}

				const configuredServerCount =
					getServersForFileWithConfig(neighborPath).length;
				if (configuredServerCount === 0) {
					logCascade({
						phase: "neighbor_fallback",
						filePath,
						neighborFile: neighborPath,
						fallbackUsed: false,
						error: "no_lsp_server_configured",
					});
					return undefined;
				}

				// A6: async read to avoid blocking event loop on network-mounted drives
				const content = await nodeFs.promises.readFile(neighborPath, "utf8");

				// #458: tier-aware cascade-lane wait. A Tier-3 (push-only,
				// silent-on-clean — typescript is the lone core-set instance today)
				// primary can never give this in-lane wait an affirmative clean
				// signal, so the budget is pure cost. Fire the touch (didOpen/
				// didChange still happens — the server starts real work) and record
				// it as outstanding for the agent_settled quiet window to reconcile
				// instead of waiting here. Ambiguous/missing capability data always
				// classifies as "waits" (today's behavior) — see cascade-tier.ts.
				// The whole attempt is try/caught: any surprise (a service shape
				// that doesn't expose getCapabilitySnapshots/getClientForFile, a
				// thrown rejection) falls through to the existing full-wait path
				// below rather than skip the wait on a failure.
				if (isTierAwareCascadeEnabled()) {
					try {
						const snapshots =
							(await lspService.getCapabilitySnapshots?.(neighborPath)) ?? [];
						const tier = classifyCascadeWaitTier(
							lspService,
							neighborPath,
							snapshots,
						);
						if (tier === "tier3-silent") {
							const spawnedForTouch =
								await lspService.getClientForFile(neighborPath);
							if (spawnedForTouch) {
								// Sampled BEFORE the touchFile notify: a publish landing
								// in the notify→record gap must read as post-touch at
								// reconcile time, never be misclassified as pre-touch
								// (the reconcile compares this against the client's
								// PER-FILE publish timestamp — see cascade-tier.ts).
								const touchedAt = Date.now();
								await lspService.touchFile(neighborPath, content, {
									diagnostics: "none",
									collectDiagnostics: false,
									silent: true,
									source: "cascade",
									clientScope: "primary",
								});
								recordOutstandingCascadeTouch({
									filePath: neighborPath,
									serverId: spawnedForTouch.client.serverId,
									touchedAt,
								});
								const durationMs = Date.now() - neighborStart;
								logCascade({
									phase: "cascade_tier3_skip",
									filePath,
									neighborFile: neighborPath,
									durationMs,
									lspServerCount: configuredServerCount,
									coldSnapshot: isColdSnapshot,
									metadata: { serverId: spawnedForTouch.client.serverId },
								});
								// Deliberately NOT cached as clean/diagnosed — the wait was
								// skipped, not resolved, so neither neighborTouchCache nor
								// recentlyCleanNeighborCache may treat this as a real answer
								// (#240 doctrine). Return undefined: the degraded-fallback
								// path below still has a chance to surface a passive/stale
								// snapshot, same as any other "no fresh data this touch" case.
								return undefined;
							}
						}
					} catch (tierErr) {
						dbg?.(
							`cascade tier-aware skip attempt failed for ${neighborPath}, falling back to full wait: ${tierErr}`,
						);
					}
				}

				// Open with silent=true (suppresses didChangeWatchedFiles rechecks, C2)
				// and collect diagnostics from the same touched clients.
				// Cold-snapshot neighbors (autoPropagate LSP, server warm) use a tighter
				// 1000ms budget — they should respond quickly; we'd rather return zero
				// than block cascade for 2s on a slow open.
				const rawDiags = await lspService.touchFile(neighborPath, content, {
					diagnostics: "document",
					collectDiagnostics: true,
					maxClientWaitMs: isColdSnapshot ? 1000 : 2000,
					silent: true,
					source: "cascade",
					clientScope: "all",
				});
				if (!rawDiags) return undefined;
				// #1093/#571/#1095: a touch result is only a CONFIRMED observation of the
				// neighbor's current on-disk state when it is neither `inconclusive` (the
				// notify/diagnostics wait lapsed — e.g. the tight 1000ms cold-snapshot
				// budget on a slow server) NOR bound-false (`binding.boundToCurrentDisk
				// === false` — the diagnostics were computed against a different disk state
				// than what's on disk now). Either disqualifier means a resolved `[]` is
				// NOT a confirmed clean: treating it as one would WIPE a live footer finding
				// (the #533 false-clean trap, worse than the stale-display bug). Both flags
				// are folded into `isConfirmedTouch` so no gate below can miss one. A
				// confirmed result reconciles and may seed the recently-clean cache; an
				// unconfirmed one does neither (else the short-circuit on the next cascade
				// would make the wipe self-sustain).
				const confirmed = isConfirmedTouch(rawDiags);
				const bindingRejected = readBoundToCurrentDisk(rawDiags) === false;
				const inconclusive = readInconclusive(rawDiags);
				// #692: `source: "cascade"` no longer overrides `rule` (see the
				// doc comment on the sibling call above) — dropped rather than
				// migrated to `scanOrigin` since cascade output never touches
				// persisted widget/dedup state.
				const diags = convertLspDiagnostics(
					rawDiags.filter((d) => d.severity === 1).slice(0, MAX_PER_FILE),
					neighborPath,
				);
				const durationMs = Date.now() - neighborStart;

				// Update cache for this neighbor at the current write sequence
				if (writeSeq != null) {
					neighborTouchCache.set(cacheKey, {
						turnSeq,
						writeSeq,
						diagnostics: diags,
					});
				}
				if (diags.length === 0) {
					// Only a CONFIRMED clean touch may seed the recently-clean cache
					// (#1095: a bound-false touch is unconfirmed, exactly like inconclusive).
					if (confirmed) {
						recentlyCleanNeighborCache.set(cacheKey, {
							turnSeq,
							checkedAt: Date.now(),
						});
					}
				} else {
					recentlyCleanNeighborCache.delete(cacheKey);
				}
				producedLspData = true;

				logCascade({
					phase: "neighbor_touch",
					filePath,
					neighborFile: neighborPath,
					diagnosticCount: diags.length,
					durationMs,
					lspTouched: true,
					lspServerCount: configuredServerCount,
					coldSnapshot: isColdSnapshot,
					// #1104: an unconfirmed touch has two independent, otherwise
					// indistinguishable causes — `inconclusive` (the notify/diagnostics
					// wait lapsed its deadline) and bound-false (`bindingState`, #1095 —
					// diagnostics computed against a diverged disk state). Surface
					// `inconclusive` unconditionally so cascade.log alone (no
					// cross-referencing latency.log) tells them apart; `bindingState`
					// stays conditional since "bound" carries no extra signal.
					metadata: {
						inconclusive,
						...(bindingRejected && { bindingState: bindingStateLabel(false) }),
					},
				});

				// #1093/#1095: a completed, CONFIRMED active touch is a confirmed
				// observation of this neighbor's current LSP-error state (#571) —
				// reconcile it into the footer widget, INCLUDING the confirmed-clean `[]`
				// case, so a fix-edit to the primary that resolves a cross-file error in
				// this neighbor clears the neighbor's now-stale footer entry (the #1092
				// defect). MERGE (genuine LSP errors only — auxiliary findings excluded,
				// see `cascadeReconcilableLspErrors`) so a live biome/ruff/aux finding or
				// LSP warning survives this errors-only re-check. Keyed by the primary
				// edit's `writeSeq` so a genuinely newer per-edit write still wins the
				// WriteOrderingGuard. `observedAt` stays now (a fresh touch). The
				// inconclusive touch, the BOUND-FALSE touch (#1095 — computed against a
				// diverged disk state), the tier-3-silent skip, the recently-clean
				// short-circuit, the within-turn cache hit, and the rejected-touch
				// fallback are all deliberately NOT reconciled — none is a confirmed
				// observation.
				if (confirmed) {
					reconcileCascadeNeighborLspErrors(
						neighborPath,
						cascadeReconcilableLspErrors(rawDiags, neighborPath),
						writeSeq,
					);
				}

				return {
					filePath: neighborPath,
					reason: neighborReason(importerSet, callerSet, neighborPath),
					diagnostics: diags,
					lspTouched: true as const,
					durationMs,
				} satisfies CascadeResult["neighbors"][number];
			}),
		);

		const allTouchPaths = [...activePaths, ...coldSnapshotPaths];
		for (let i = 0; i < touchResults.length; i++) {
			const result = touchResults[i];
			const neighborPath = allTouchPaths[i];
			if (result.status === "fulfilled") {
				if (result.value) neighbors.push(result.value);
			} else {
				// A3: one failed LSP doesn't kill the rest — fall back to passive snapshot
				dbg?.(
					`cascade neighbor touch error for ${neighborPath}: ${result.reason}`,
				);
				const entry = allDiags.get(normalizeMapKey(neighborPath));
				const ttlFresh =
					entry != null && Date.now() - entry.ts < CASCADE_TTL_MS;
				// #1104: consult binding before trusting a TTL-fresh fallback snapshot —
				// MATCH #1100/#1095 semantics (false → skip, "unknown" → keep the
				// pre-#1104 TTL-only behavior, true → use). Without this, a failed
				// active touch could still re-display a bound-false (pre-fix-edit)
				// snapshot even though the reconcile path (#1100) already refuses to
				// trust it for the widget — the widget is protected but the display
				// wasn't. Reading `.binding` triggers the lazy disk verify — done ONLY
				// when TTL-fresh, same discipline as the snapshot-tier gate above.
				const boundToDisk: BoundToCurrentDisk | undefined = ttlFresh
					? readBoundToCurrentDisk(entry)
					: undefined;
				const bindingRejected = boundToDisk === false;
				if (bindingRejected) fallbackBindingRejected = true;
				logCascade({
					phase: "neighbor_fallback",
					filePath,
					neighborFile: neighborPath,
					fallbackUsed: true,
					error: String(result.reason),
					// #1104: distinguish a binding-rejected fallback (TTL-fresh but the
					// server's view diverged from disk) from a plain TTL-stale/missing
					// one — same conditional pattern as the neighbor_touch/neighbor_snapshot
					// phases above.
					...(bindingRejected && {
						metadata: { bindingState: bindingStateLabel(boundToDisk) },
					}),
				});
				// #692: `source: "cascade"` dropped (see the doc comment above the
				// first cascade call site in this file) — no longer affects `rule`
				// and cascade output never touches persisted widget/dedup state.
				const diags =
					ttlFresh && !bindingRejected
						? convertLspDiagnostics(
								entry.diags
									.filter((d) => d.severity === 1)
									.slice(0, MAX_PER_FILE),
								neighborPath,
							)
						: [];
				neighbors.push({
					filePath: neighborPath,
					reason: "fallback",
					diagnostics: diags,
					lspTouched: false,
				});
			}
		}
	}

	// CR-3/A2: degraded fallback when no neighbor produced trustworthy LSP data —
	// not merely when the graph returned zero neighbors.
	if (!producedLspData) {
		const bindingRejected = appendFallbackNeighbors(
			neighbors,
			allDiags,
			normalizedFileKey,
			cwd,
			filePath,
		);
		if (bindingRejected) fallbackBindingRejected = true;
		if (neighbors.some((n) => n.reason === "fallback")) {
			logCascade({
				phase: "neighbor_fallback",
				filePath,
				fallbackUsed: true,
				neighborCount: neighbors.length,
			});
		}
	}

	const visibleNeighbors = applyCascadeDeltaBaselines(neighbors);

	const formatted = formatCascadeResult(
		cwd,
		impact,
		visibleNeighbors,
		impact.neighborFiles.length,
	);

	// #1104 HONESTY: filtering a bound-false display candidate must not turn a
	// degraded/indeterminate cascade into a clean-looking one (same doctrine as
	// #1023's graph-degraded marker). If every candidate the degraded-fallback
	// paths considered this run was binding-rejected and nothing else produced
	// output, thread the SAME indeterminate marker #1023 built so the turn-end
	// advisory (clients/runtime-turn.ts) surfaces an honest note instead of
	// silence — never let a withheld-stale-snapshot run look like a genuine
	// clean leaf. `!impact.indeterminate` preserves a graph-degraded marker that
	// already exists (never overwritten).
	if (!formatted && fallbackBindingRejected && !impact.indeterminate) {
		impact.indeterminate = {
			reason: "lsp_binding_rejected",
			detail:
				"cascade fallback diagnostics were withheld — stale snapshot content did not match current disk (binding rejected)",
		};
	}

	const filesWithErrors = visibleNeighbors.filter(
		(n) => n.diagnostics.length > 0,
	).length;
	logCascade({
		phase: "cascade_result",
		filePath,
		neighborCount: visibleNeighbors.length,
		diagnosticCount: visibleNeighbors.reduce(
			(sum, n) => sum + n.diagnostics.length,
			0,
		),
		metadata: {
			filesWithErrors,
			hasOutput: formatted.length > 0,
			// Log when cascade ran but found nothing — distinguishes "clean" from "no signal"
			noNeighbors: visibleNeighbors.length === 0,
			noErrors: visibleNeighbors.length > 0 && filesWithErrors === 0,
			neighbors: visibleNeighbors.slice(0, 10).map((n) => ({
				file: n.filePath.replace(/\\/g, "/").split("/").slice(-2).join("/"),
				diagnostics: n.diagnostics.length,
			})),
		},
	});

	const diagCount = visibleNeighbors.reduce(
		(sum, n) => sum + n.diagnostics.length,
		0,
	);

	cascadeSessionStats.runs += 1;
	cascadeSessionStats.diagnosticsSurfaced += diagCount;
	cascadeSessionStats.coldSnapshotTouches += coldSnapshotPaths.length;

	if (!formatted) {
		// #1023: an indeterminate compute (degraded/cold/missing-node graph) must
		// NOT collapse into "no_neighbors" — that is the exact silent all-clear the
		// bug is about. Distinguish it by the marker threaded onto `impact`, never
		// by `visibleNeighbors.length === 0` alone (a healthy leaf is also empty).
		if (impact.indeterminate) {
			return {
				filePath,
				result: undefined,
				neighborCount: visibleNeighbors.length,
				diagnosticCount: diagCount,
				skipReason: "indeterminate",
				indeterminate: impact.indeterminate,
			};
		}
		const skipReason: CascadeSkipReason =
			visibleNeighbors.length === 0 ? "no_neighbors" : "clean";
		return {
			filePath,
			result: undefined,
			neighborCount: visibleNeighbors.length,
			diagnosticCount: diagCount,
			skipReason,
		};
	}

	getDiagnosticTracker().trackShown(
		visibleNeighbors.flatMap((n) => n.diagnostics),
	);

	return {
		filePath,
		result: { filePath, impact, neighbors: visibleNeighbors, formatted },
		neighborCount: visibleNeighbors.length,
		diagnosticCount: diagCount,
		// #1023: even when some fallback neighbors surfaced, a degraded graph means
		// the dependent set is INCOMPLETE — carry the marker so the turn-end seam
		// still notes downstream impact was under-computed this turn.
		...(impact.indeterminate && { indeterminate: impact.indeterminate }),
	};
}

function diagnosticDeltaKey(
	diagnostic: import("./types.js").Diagnostic,
): string {
	return [
		diagnostic.id,
		diagnostic.rule ?? "",
		diagnostic.line ?? 0,
		diagnostic.column ?? 0,
		diagnostic.message,
	].join(":");
}

function applyCascadeDeltaBaselines(
	neighbors: CascadeResult["neighbors"],
): CascadeResult["neighbors"] {
	return neighbors.map((neighbor) => {
		const baselineKey = `session.baseline.cascade.${normalizeMapKey(neighbor.filePath)}`;
		const previous =
			cascadeDiagnosticBaselines.get(baselineKey) ??
			sessionFacts.getSessionFact<import("./types.js").Diagnostic[]>(
				baselineKey,
			);
		cascadeDiagnosticBaselines.set(baselineKey, [...neighbor.diagnostics]);
		sessionFacts.setSessionFact(baselineKey, [...neighbor.diagnostics]);
		if (!previous) return neighbor;
		const before = new Set(previous.map(diagnosticDeltaKey));
		return {
			...neighbor,
			diagnostics: neighbor.diagnostics.filter(
				(diagnostic) => !before.has(diagnosticDeltaKey(diagnostic)),
			),
		};
	});
}

/**
 * Returns `true` when at least one otherwise-eligible candidate was withheld
 * because its content binding was rejected (#1104) — the caller folds this
 * into the run-level `fallbackBindingRejected` flag for the honesty check.
 */
function appendFallbackNeighbors(
	neighbors: CascadeResult["neighbors"],
	allDiags: Map<
		string,
		{ diags: import("../lsp/client.js").LSPDiagnostic[]; ts: number }
	>,
	normalizedFileKey: string,
	cwd: string,
	filePath: string,
): boolean {
	const now = Date.now();
	const seen = new Set(neighbors.map((n) => normalizeMapKey(n.filePath)));
	let bindingRejected = false;
	for (const [diagPath, entry] of allDiags) {
		const { diags, ts } = entry;
		const diagKey = normalizeMapKey(diagPath);
		if (diagKey === normalizedFileKey || seen.has(diagKey)) continue;
		if (primaryFilesThisTurn.has(diagKey)) continue;
		if (isExternalOrVendorFile(diagPath, cwd)) continue;
		if (isIgnoredCascadeNeighbor(diagPath, cwd)) continue;
		// #1080: a KNOWN test-role file must not surface as a collateral fallback
		// neighbor either (the passive-snapshot path the graph/reference filters
		// above never reach). Ignore filtering (#297) stays separate and above.
		if (isTestRoleCollateral(diagPath)) continue;
		if (!nodeFs.existsSync(diagPath)) continue;
		if (now - ts > CASCADE_TTL_MS) continue;
		// #1104: a TTL-fresh entry is not automatically trustworthy — consult
		// binding the same way the reconcile path (#1100) and the touch-error
		// fallback above do. `false` → skip (a stale/pre-fix-edit snapshot whose
		// server view diverged from current disk); "unknown"/`true` → unchanged
		// (the pre-#1104 fallback contract). Reading `.binding` triggers the lazy
		// disk verify — done ONLY when TTL-fresh, per the established discipline.
		const boundToDisk = readBoundToCurrentDisk(entry);
		if (boundToDisk === false) {
			bindingRejected = true;
			logCascade({
				phase: "neighbor_fallback",
				filePath,
				neighborFile: diagPath,
				fallbackUsed: false,
				metadata: { bindingState: bindingStateLabel(false) },
			});
			continue;
		}
		// #692: `source: "cascade"` dropped — see the doc comment above the
		// first cascade `convertLspDiagnostics` call site in this file.
		const errors = convertLspDiagnostics(
			diags.filter((d) => d.severity === 1).slice(0, MAX_PER_FILE),
			diagPath,
		);
		if (errors.length === 0) continue;
		neighbors.push({
			filePath: diagPath,
			reason: "fallback",
			diagnostics: errors,
			lspTouched: false,
		});
		seen.add(diagKey);
		if (neighbors.length >= MAX_FILES) break;
	}
	return bindingRejected;
}

function shouldReadCascadeFromSnapshot(filePath: string): boolean {
	return getServersForFileWithConfig(filePath).some(
		(server) => server.autoPropagateDiagnostics === true,
	);
}

function neighborReason(
	importerSet: Set<string>,
	callerSet: Set<string>,
	neighborPath: string,
): CascadeResult["neighbors"][number]["reason"] {
	if (importerSet.has(neighborPath)) return "imports";
	if (callerSet.has(neighborPath)) return "calls";
	return "references";
}

function formatCascadeResult(
	cwd: string,
	impact: ReturnType<typeof computeImpactCascade>,
	neighbors: CascadeResult["neighbors"],
	totalNeighbors: number,
): string {
	const diagnosticsBlock = formatCascadeNeighborDiagnostics(cwd, neighbors, {
		noun: "neighbor",
		includeReason: true,
	});
	if (!diagnosticsBlock) return "";

	const impactHeader = formatImpactCascade(
		impact,
		RUNTIME_CONFIG.pipeline.cascadeMaxFiles,
	);
	let out = impactHeader
		? `${impactHeader}\n${diagnosticsBlock}`
		: diagnosticsBlock;

	// A10: include truncated filenames so agent knows which files were cut
	const truncated = totalNeighbors - neighbors.length;
	if (truncated > 0) {
		const truncatedNames = impact.neighborFiles
			.slice(neighbors.length, neighbors.length + 3)
			.map((p) => toRunnerDisplayPath(cwd, p))
			.join(", ");
		const moreLabel = truncatedNames
			? `${truncated} more dependent file(s): ${truncatedNames}`
			: `${truncated} more dependent file(s)`;
		out += `\n... and ${moreLabel}`;
	}

	return out;
}

/**
 * Run linting for a file using the declarative dispatch system
 *
 * @param filePath - Path to the file to lint
 * @param cwd - Project root directory
 * @param pi - Pi agent API (for flags)
 * @returns Output string to display to user
 */
export async function dispatchLint(
	filePath: string,
	cwd: string,
	pi: PiAgentAPI,
	modifiedRanges?: ModifiedRange[],
	projectRoot?: string,
): Promise<string> {
	// By default, only run BLOCKING rules for fast feedback on file write
	// Uses persistent sessionBaselines so delta mode actually filters
	// pre-existing issues after the first write.
	const ctx = createDispatchContext(
		filePath,
		cwd,
		pi,
		sessionFacts,
		true,
		modifiedRanges,
		projectRoot,
	);
	sessionFacts.clearFileFactsFor(ctx.filePath);

	const kind = ctx.kind;
	if (!kind) return "";

	const groups = withSpotbugsGroup(
		kind,
		getDispatchGroupsForKind(kind, pi),
		ctx,
	);
	if (groups.length === 0) return "";

	await runProviders(ctx);
	const result = await dispatchForFile(ctx, groups, sessionRunnerRegistry);
	trackSessionSlopStats(ctx, result.diagnostics);
	return result.output;
}

/**
 * Run linting and return full result (including diagnostics)
 */
export async function dispatchLintWithResult(
	filePath: string,
	cwd: string,
	pi: PiAgentAPI,
	modifiedRanges?: ModifiedRange[],
	logContext?: LogContext,
	options?: { blockingOnly?: boolean; projectRoot?: string },
): Promise<DispatchResult> {
	// Default true preserves the per-edit fast path (errors only). Callers that
	// want the full picture (warnings + structural smells), e.g. the MCP review
	// facade, pass blockingOnly=false to run every runner.
	const ctx = createDispatchContext(
		filePath,
		cwd,
		pi,
		sessionFacts,
		options?.blockingOnly ?? true,
		modifiedRanges,
		options?.projectRoot,
	);
	sessionFacts.clearFileFactsFor(ctx.filePath);

	const kind = ctx.kind;
	if (!kind) {
		return {
			diagnostics: [],
			blockers: [],
			warnings: [],
			baselineWarningCount: 0,
			fixed: [],
			resolvedCount: 0,
			output: "",
			blockerOutput: "",
			hasBlockers: false,
		};
	}

	const groups = withSpotbugsGroup(
		kind,
		getDispatchGroupsForKind(kind, pi),
		ctx,
	);
	if (groups.length === 0) {
		return {
			diagnostics: [],
			blockers: [],
			warnings: [],
			baselineWarningCount: 0,
			fixed: [],
			resolvedCount: 0,
			output: "",
			blockerOutput: "",
			hasBlockers: false,
		};
	}

	await runProviders(ctx);
	const result = await dispatchForFile(ctx, groups, sessionRunnerRegistry);
	trackSessionSlopStats(ctx, result.diagnostics);

	// Schedule debounced ast-grep warning scan for jsts files.
	// Runs 2s after the last write — collapses rapid sequential edits into one scan.
	// Results are logged only, never surfaced to the agent.
	if (kind === "jsts" && logContext) {
		scheduleAstGrepWarningScan(filePath, cwd, pi, logContext);
	}

	return result;
}

/** Per-runner outcome captured while driving the real dispatch path. */
export interface RunnerOutcome {
	runnerId: string;
	result: RunnerResult;
}

/**
 * Same real dispatch path as {@link dispatchLintWithResult} (real context, real
 * file-kind→runner selection, real `run()` → spawn → tool), but also returns
 * each runner's exact `RunnerResult` (status + `failureKind` + diagnostics) via
 * the `onRunnerResult` sink. The live tool-smoke harness (#209) uses this to
 * assert each supported tool spawned and exited cleanly without re-implementing
 * dispatch's selection/gating. Defaults to `blockingOnly: false` so every
 * applicable runner (not just blocking ones) executes.
 */
export async function dispatchLintDetailed(
	filePath: string,
	cwd: string,
	pi: PiAgentAPI,
	options?: {
		blockingOnly?: boolean;
		modifiedRanges?: ModifiedRange[];
		projectRoot?: string;
	},
): Promise<{ result: DispatchResult; runners: RunnerOutcome[] }> {
	const empty: DispatchResult = {
		diagnostics: [],
		blockers: [],
		warnings: [],
		baselineWarningCount: 0,
		fixed: [],
		resolvedCount: 0,
		output: "",
		blockerOutput: "",
		hasBlockers: false,
	};

	const ctx = createDispatchContext(
		filePath,
		cwd,
		pi,
		sessionFacts,
		options?.blockingOnly ?? false,
		options?.modifiedRanges,
		options?.projectRoot,
	);
	sessionFacts.clearFileFactsFor(ctx.filePath);

	const kind = ctx.kind;
	if (!kind) return { result: empty, runners: [] };

	const groups = withSpotbugsGroup(
		kind,
		getDispatchGroupsForKind(kind, pi),
		ctx,
	);
	if (groups.length === 0) return { result: empty, runners: [] };

	const runners: RunnerOutcome[] = [];
	const sink: RunnerResultSink = (runnerId, result) => {
		runners.push({ runnerId, result });
	};

	await runProviders(ctx);
	const result = await dispatchForFile(
		ctx,
		groups,
		sessionRunnerRegistry,
		sink,
	);
	trackSessionSlopStats(ctx, result.diagnostics);

	return { result, runners };
}

/**
 * Check if a file should be processed by the dispatcher
 * based on the file kind
 */
export function shouldDispatch(filePath: string): boolean {
	const kind = detectFileKind(filePath);
	return kind !== undefined;
}

/**
 * Get list of available runners for a file
 */
export async function getAvailableRunners(filePath: string): Promise<string[]> {
	const kind = detectFileKind(filePath);
	if (!kind) return [];

	const normalizedPath = filePath.replace(/\\/g, "/");
	const pathForFilter = normalizedPath.startsWith("/")
		? normalizedPath
		: `/${normalizedPath}`;
	const runners = sessionRunnerRegistry.getForKind(kind, pathForFilter);
	return runners.map((r) => r.id);
}
