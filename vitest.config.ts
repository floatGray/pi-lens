import { defineConfig } from "vitest/config";

// Applies to globalSetup as well as workers: ordinary tests never install tools.
process.env.PI_LENS_DISABLE_TOOL_INSTALL ??= "1";

// Background coding agents get worktrees under .claude/worktrees/ — vitest's
// default exclude covers node_modules/.git/dist but NOT those, so a "full
// suite" run in the main tree silently swept every agent's IN-PROGRESS
// worktree tests too (seen 2026-07-11: 40+ phantom failures, all from
// half-finished branches in sibling worktrees).
const sharedExclude = [
	"**/node_modules/**",
	"**/dist/**",
	"**/.{git,cache,output,temp}/**",
	"**/.claude/**",
];

// The two slow real-process files `npm run test:integration` runs on their own.
// `npm run test:unit` is the complement, and the switch has to live here: every
// project below sets its own `exclude`, which REPLACES the root/CLI value
// outright, so a `vitest run --exclude <file>` on the command line is silently
// ignored (it was, from #1101 until 2026-08-06). npm exports the script name it
// is running, and that survives the with-test-lock wrapper identically on every
// OS — unlike an inline `FOO=1 …` prefix, which cmd.exe cannot parse.
// `test:integration` names these same two files positionally in package.json
// (a positional filter DOES survive) — keep the two lists in step.
const integrationInclude = [
	"tests/index-integration.test.ts",
	"tests/clients/lsp/integration.test.ts",
];
const unitOnlyExclude =
	process.env.npm_lifecycle_event === "test:unit" ? integrationInclude : [];

const sharedGlobalSetup = [
	"./tests/support/check-build-freshness.ts",
	"./tests/support/prewarm-grammars.ts",
	// After check-build-freshness: the seed analyze runs the in-place build.
	"./tests/support/prewarm-tool-home.ts",
];

const sharedSetupFiles = ["./tests/support/vitest-setup.ts"];

// Local runs: cap forks at half the cores (measured 2026-07-29 on a
// 16-core host, post dead-wait removal: 8 forks ≈ 40s / 9-11 GB peak
// RSS; 6 forks ≈ 44s / 8 GB; the old uncapped 15 forks gave the same
// memory for a slower wall). CI keeps vitest's default — its 4-core
// runner has no worker headroom to give back. Memory-constrained runs:
// PI_LENS_TEST_MAX_WORKERS=6.
const sharedMaxWorkers = process.env.CI
	? undefined
	: Number(process.env.PI_LENS_TEST_MAX_WORKERS) || "50%";

// Worker heap headroom: the full suite occasionally died with a "Worker
// exited unexpectedly" + a `node::GetNodeReport` dump. That report is emitted
// by Node's OWN fatal-error handler (V8 heap-limit reached) — an external OS
// OOM-kill SIGKILLs with no dump — so the crash is a single long-lived worker
// hitting its own V8 heap ceiling, not system memory exhaustion (32-core /
// 68 GB host). With `isolate: true` (vitest's default) each worker's module
// registry is reset per file, so the native addons (the many tree-sitter
// grammars + @ast-grep/napi) are re-loaded file-after-file and their off- and
// on-heap buffers accumulate in the reused worker until a heavy worker tips
// over. `execArgv` passes --max-old-space-size to every spawned worker,
// giving that headroom WITHOUT capping worker count (no CI slowdown);
// aggregate risk is negligible (workers never all peak at once, and 4 GB ×
// workers ≪ host RAM). Tune via PI_LENS_TEST_WORKER_HEAP_MB. NOTE: Vitest 4
// flattened the config — `execArgv` is a direct `test` field (the v3
// `poolOptions.forks.execArgv` nesting no longer exists and is silently
// ignored).
const sharedExecArgv = [
	`--max-old-space-size=${process.env.PI_LENS_TEST_WORKER_HEAP_MB || 4096}`,
];

// Tier 1 fix (#902): these files all transitively drive real tree-sitter
// grammar parses (via clients/review-graph/builder.js or the project-diagnostics
// scanner), and `isolate: true` (required — see above, and removing it
// reintroduces the V8 heap-ceiling crash) means each test FILE gets a fresh
// module registry, so the native grammar addons get re-loaded/re-compiled
// per file rather than once per worker. Grammar prewarm
// (tests/support/prewarm-grammars.ts) only pre-fetches the wasm BYTES to
// disk — it does nothing to stop several of these files re-compiling their
// grammars concurrently once spread across forks under the default
// `maxWorkers: "50%"`. That contention was intermittently blowing past the
// fork teardown deadline ("Timeout terminating forks worker") even though
// every test in the file had already passed. Carving this glob into its own
// project with a small capped `maxWorkers` bounds how many of these heavy
// files compile grammars at once, without reducing parallelism for the rest
// of the suite (which keeps its existing `maxWorkers: "50%"` in the
// "default" project below).
const grammarHeavyInclude = [
	"tests/clients/review-graph/shared-extraction-ir.test.ts",
	"tests/clients/review-graph/tsconfig-paths.test.ts",
	"tests/clients/review-graph/extract-symbols.test.ts",
	"tests/clients/project-diagnostics/scanner.test.ts",
	// #1089: these two co-load most of the grammar set (incl. the heavy
	// swift/cpp/kotlin/csharp four) for the call-graph fixture matrices —
	// the exact #255/#902 contention shape this project exists to bound.
	"tests/clients/tree-sitter-call-graph.test.ts",
	"tests/clients/module-report-call-graph.test.ts",
];

// Tier 2 fix (#902): event-loop *occupancy* guards (measureMaxSyncBlockMs —
// see tests/support/perf-harness.ts) measure the longest synchronous stretch
// the code under test holds the loop, via an independent setImmediate
// sampler. That sampler is a real event-loop citizen: it only gets scheduled
// when the OS actually gives this process a turn. Under the "default"
// project's `maxWorkers: "50%"` — dozens of sibling forks doing grammar
// compiles, `ast-grep`/biome child-process spawns, and LSP server smoke
// tests all competing for cores — the sampler itself can be descheduled for
// a while, which the guard cannot tell apart from the code under test
// actually blocking. That's a scheduling-jitter false positive, not the
// regression the guard exists to catch (confirmed 2026-07-31: both files
// pass cleanly and repeatedly run solo; they only fail mid-"default"-project
// full-suite runs, alongside grammar/CLI-heavy sibling files). Widening the
// ms threshold can't absorb this without also hiding the real ~800ms+
// non-yielding-walk regression the tests guard against (#188/#191/#192) —
// so, same fix shape as the grammar-heavy project above: reduce how much
// sibling-fork noise coincides with the *measurement window* itself, not
// how tolerant the measurement is. A capped, phased-last project means by
// the time these run, the default project's fork storm (and grammar-heavy's
// smaller one) has already fully drained, so the sampler only ever
// contends with (at most) one other file in this group.
const timingSensitiveInclude = [
	"tests/clients/source-walk-occupancy.test.ts",
	"tests/clients/source-filter-async.test.ts",
	// Workspace-edit planning also uses the independent occupancy sampler; keep
	// its measurement window out of the default fork storm while the guard still
	// catches a genuinely non-yielding planner.
	"tests/clients/lsp/edits.test.ts",
	// Same measureMaxSyncBlockMs sampler + same contention-starvation flake
	// (observed 2026-07-31: cold buildOrUpdateGraph blew the 300ms budget at
	// ~82s under a full-suite fork storm, exhausting its retry:2). Its
	// existing retry isn't enough on its own; phasing it here removes the
	// sibling-fork noise the sampler was actually measuring.
	"tests/clients/cascade-graph-occupancy.test.ts",
];

// #1022 fix: the "workspace LSP winner" case in this file spawns a REAL
// ast-grep LSP child process and waits on its `initialize` handshake plus
// its first-document diagnostics — both bounded by ast-grep's own
// deliberately-generous initializeTimeoutMs (~15s, see clients/lsp/server.ts)
// because the first scan of a session compiles the full rule set (~350
// files incl. the CodeRabbit catalog). `client.waitForDiagnostics`
// (clients/lsp/client.ts) resolves SILENTLY on timeout rather than throwing,
// so under the "default" project's `maxWorkers: "50%"` fork storm — dozens
// of sibling forks doing grammar compiles and their own process spawns —
// CPU contention can starve this real spawn past its budget, and that
// starvation surfaces not as a timeout but as a false "diagnostic not
// found" assertion failure (confirmed via 2026-08-01 repro: solo run green
// every time, full-suite run intermittently red on exactly this case).
// Same fix shape as grammar-heavy/timing-sensitive above: phase this file
// into its own low-concurrency, last-running project so its real-LSP-spawn
// budget window never has to compete with the rest of the suite's fork
// storm for CPU turns. This removes the CONTENTION rather than just
// widening the timeout (see the companion budget-alignment fix in the test
// file itself, which corrects the timeout values to match ast-grep's own
// declared budget instead of a shorter invented constant — belt-and-braces,
// not a substitute for phasing).
const lspSpawnHeavyInclude = [
	"tests/clients/ast-grep-rule-precedence-followups.test.ts",
];

export default defineConfig({
	test: {
		exclude: sharedExclude,
		// Root-config-only in Vitest 4 (see the grammar-heavy project's comment
		// below) — applies to every project's fork teardown, not just the
		// grammar-heavy one, which is strictly more forgiving everywhere else.
		teardownTimeout: 30_000,
		projects: [
			{
				test: {
					name: "default",
					exclude: [
						...sharedExclude,
						...unitOnlyExclude,
						...grammarHeavyInclude,
						...timingSensitiveInclude,
						...lspSpawnHeavyInclude,
					],
					globalSetup: sharedGlobalSetup,
					setupFiles: sharedSetupFiles,
					maxWorkers: sharedMaxWorkers,
					execArgv: sharedExecArgv,
					// Vitest 4 requires distinct groupOrder whenever projects have
					// different `maxWorkers` — see the "grammar-heavy" project below
					// for why that's actually desirable here, not just a workaround.
					sequence: { groupOrder: 0 },
				},
			},
			{
				test: {
					name: "grammar-heavy",
					include: grammarHeavyInclude,
					exclude: sharedExclude,
					globalSetup: sharedGlobalSetup,
					setupFiles: sharedSetupFiles,
					execArgv: sharedExecArgv,
					// Cap, don't serialize: bounds concurrent grammar re-compiles to
					// 2-at-a-time instead of whatever `maxWorkers: "50%"` would give
					// them (the root cause above), without going fully sequential.
					// NOTE: Vitest 4 removed `poolOptions.forks.maxForks` — pool
					// concurrency knobs were unified into the top-level
					// `maxWorkers` (applies to whichever pool is active; this repo
					// uses the default `forks` pool everywhere).
					maxWorkers: 2,
					// Distinct groupOrder is required whenever projects have
					// different `maxWorkers` (Vitest 4 throws otherwise). Side
					// effect: scheduling groups run as sequential PHASES (group 0
					// fully drains, then group 1 starts) rather than interleaved —
					// a feature here, not a cost: it guarantees these 4
					// grammar-heavy files never share fork-scheduling time with the
					// rest of the suite, so they can never race a batch of OTHER
					// files' concurrent grammar compiles either.
					sequence: { groupOrder: 1 },
					// Supplement, not a substitute for the maxForks cap above: give
					// fork teardown more headroom in case a heavy grammar compile is
					// still finishing when a test file's hooks wrap up.
					// NOTE: Vitest 4's per-project `ProjectConfig` type excludes
					// `teardownTimeout` (it moved to root-config-only), so the 30s
					// bump lives on the top-level `test` block below instead —
					// applies to both projects, which only makes the default
					// project's teardown MORE forgiving, never less.
					hookTimeout: 60_000,
				},
			},
			{
				test: {
					name: "timing-sensitive",
					include: timingSensitiveInclude,
					exclude: sharedExclude,
					globalSetup: sharedGlobalSetup,
					setupFiles: sharedSetupFiles,
					execArgv: sharedExecArgv,
					// Small cap (not full serialization — these two files can still
					// share the phase) so the event-loop-occupancy sampler in each
					// (measureMaxSyncBlockMs, see perf-harness.ts) isn't competing
					// with a large fork pool for CPU turns while it's mid-measurement.
					maxWorkers: 2,
					// Its own phase, after both "default" and "grammar-heavy" drain
					// (required anyway once maxWorkers differs from "default" — see
					// the grammar-heavy project above). By running last and alone,
					// these occupancy guards get a (near-)quiet host for their
					// measurement window instead of racing the full-suite fork storm
					// that was intermittently starving their sampler and tripping the
					// budget on ambient scheduling delay, not a real regression.
					sequence: { groupOrder: 2 },
					hookTimeout: 60_000,
				},
			},
			{
				test: {
					name: "lsp-spawn-heavy",
					include: lspSpawnHeavyInclude,
					exclude: sharedExclude,
					globalSetup: sharedGlobalSetup,
					setupFiles: sharedSetupFiles,
					execArgv: sharedExecArgv,
					// Full serialization, not just a cap: this is a single file, so
					// there are no siblings to share the phase with anyway — the
					// point is to guarantee zero overlap with the "default" project's
					// fork storm (the actual contention source, see #1022 above), not
					// to bound intra-project concurrency.
					maxWorkers: 1,
					// Last phase: by the time this runs, "default", "grammar-heavy",
					// and "timing-sensitive" have all fully drained, so the real
					// ast-grep LSP spawn's initialize/diagnostics budget window gets
					// a quiet host instead of racing the rest of the suite.
					sequence: { groupOrder: 3 },
					// Real LSP process spawn + rule-set compile can legitimately use
					// most of its declared ~15s budget twice over (initialize, then
					// first-document diagnostics) before shutdown; give teardown the
					// same headroom as the other heavy projects.
					hookTimeout: 60_000,
				},
			},
		],
	},
});
