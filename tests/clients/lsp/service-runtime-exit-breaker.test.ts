/**
 * Regression coverage for #1127 (opengrep respawn churn, #1122 Phase C).
 *
 * `LSPService`'s circuit breaker (`clients/lsp/index.ts`) only counted
 * spawn/initialize FAILURES toward `failureCounts` → exponential cooldown →
 * permanent disable after BROKEN_PERMANENT_AFTER. A server whose spawn
 * SUCCEEDS but then exits shortly after (opengrep's post-init "Unhandled
 * message" crash) hit the "dead client — needs respawn" path instead, which
 * never touched the breaker: 37 respawns in one real session, never
 * converging.
 *
 * The fix adds a parallel `runtimeExitCounts` counter, fed only by EARLY
 * (lifetime < RUNTIME_EXIT_UPTIME_THRESHOLD_MS) non-intentional exits, sharing
 * the same cooldown formula and the same `state.broken`/`permanentlyBroken`
 * maps as the existing breaker. Deliberate teardowns (`shutdown()` called by
 * pi-lens itself — session reset, #743 notify-backpressure eviction) set
 * `shutdownRequested` and must never count.
 *
 * Crucially, "lifetime" is measured from the client's own recorded death
 * (`getExitedAt()`, stamped by `client.ts`'s exit handlers the moment the
 * process/connection actually dies) — NOT from when a later `getClientForFile`
 * call happens to detect the client is dead. #1127's real-world pattern is
 * attach-triggered respawns "minutes to hours apart": a server that died 5s
 * after spawning but wasn't attached-to again for an hour must still read as
 * an early, breaker-worthy exit.
 *
 * Test keys are computed via `normalizeMapKey`, not hardcoded, because
 * `isWindowsPath()` (clients/path-utils.ts) treats a drive-letter-shaped
 * string like "C:/repo" as Windows-shaped on ANY platform, routing it
 * through the realpath-fallback branch even on Linux CI. A
 * platform-dependent `dirname` call inside that fallback then collapses the
 * non-existent path down to `process.cwd()`, producing a real key that is
 * NOT the literal "C:/repo" — it only stays byte-identical on Windows,
 * which is why an earlier version of this file (hardcoding the key) passed
 * locally but failed on Linux CI: the hardcoded literal silently diverged
 * from the key the service actually used internally, so map lookups missed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeMapKey } from "../../../clients/path-utils.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient,
}));

/**
 * A fake client whose `isAlive()`/`wasShutdownIntentional()`/`getExitedAt()`
 * the test drives directly. `exitedAt` defaults to `undefined` (not yet died)
 * and is only set via `die()`, mirroring the real client.ts contract: it's
 * stamped once, at the moment of death, independent of when anything later
 * notices via `isAlive()`.
 */
function makeFakeClient(serverId: string) {
	const fake = {
		alive: true,
		intentional: false,
		exitedAt: undefined as number | undefined,
		diagnosticsVersion: 0,
		serverId,
		isAlive: () => fake.alive,
		wasShutdownIntentional: () => fake.intentional,
		getExitedAt: () => fake.exitedAt,
		shutdown: vi.fn().mockImplementation(async () => {
			fake.intentional = true; // mirrors clientShutdown() setting shutdownRequested
		}),
		notify: {
			open: vi.fn().mockResolvedValue(undefined),
			change: vi.fn().mockResolvedValue(undefined),
		},
		/** Unexpected crash: dies at `at` (defaults to now), never called shutdown(). */
		die(at: number = Date.now()) {
			fake.exitedAt = at;
			fake.alive = false;
		},
	};
	return fake;
}

function makeSpawnServer(id: string) {
	let spawnCount = 0;
	const spawn = vi.fn(async () => {
		spawnCount++;
		return {
			process: {
				process: { killed: false, kill: vi.fn() },
				stdin: {} as any,
				stdout: {} as any,
				stderr: {} as any,
				pid: 1000 + spawnCount,
			},
		};
	});
	return {
		id,
		name: id,
		extensions: [".fake"],
		root: async () => "C:/repo",
		spawn,
		getSpawnCount: () => spawnCount,
	};
}

describe("LSPService circuit breaker — post-init runtime exits (#1127)", () => {
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("converges: N+1 early crash-loop respawns stop re-attaching and give up (fails on pre-fix unbounded respawn)", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const internal = service as unknown as {
			state: { broken: Map<string, number>; clients: Map<string, unknown> };
			runtimeExitCounts: Map<string, number>;
			permanentlyBroken: Set<string>;
		};

		const server = makeSpawnServer("opengrep");
		getServersForFileWithConfig.mockReturnValue([server]);

		const clients: Array<ReturnType<typeof makeFakeClient>> = [];
		createLSPClient.mockImplementation(async () => {
			const c = makeFakeClient("opengrep");
			clients.push(c);
			return c;
		});

		const file = "C:/repo/main.fake";
		// See header comment: key computed via normalizeMapKey, not hardcoded.
		const key = `opengrep:${normalizeMapKey("C:/repo")}`;
		const BROKEN_PERMANENT_AFTER = 5;

		// Initial spawn — no existing (dead) client yet, so this goes straight
		// through spawnClient() and never touches the breaker.
		const initial = await service.getClientForFile(file);
		expect(initial).toBeDefined();
		clients.at(-1)!.die(); // post-init crash, right now — never called shutdown()

		// A generous bound so an unbounded-respawn regression fails the test
		// instead of looping forever: on pre-fix master this loop runs past
		// BROKEN_PERMANENT_AFTER without ever converging (permanentlyBroken never
		// gets set), and the final assertions below catch that.
		const MAX_CYCLES = BROKEN_PERMANENT_AFTER + 5;

		for (let cycle = 0; cycle < MAX_CYCLES; cycle++) {
			// Each crash cycle is two calls: the first detects the dead client
			// (counts the failure, sets the cooldown, and — because the cooldown
			// it JUST set is checked in that same call — returns undefined even
			// though the count itself moved). Simulate the cooldown elapsing
			// before it (real wall-clock waits, up to 5 minutes at the cap, would
			// make this test glacial) and confirm no respawn happens yet.
			internal.state.broken.delete(key);
			const detect = await service.getClientForFile(file);
			expect(detect).toBeUndefined();

			if (internal.permanentlyBroken.has(key)) {
				// Converged: give-up latched on this detection. No further spawn
				// attempt happens even though nothing else changed.
				break;
			}

			// Still within budget — clear the (just-set) cooldown again to reach
			// the actual respawn attempt, then kill the fresh client immediately.
			internal.state.broken.delete(key);
			const respawn = await service.getClientForFile(file);
			expect(respawn).toBeDefined();
			clients.at(-1)!.die();
		}

		expect(internal.permanentlyBroken.has(key)).toBe(true);
		expect(internal.runtimeExitCounts.get(key)).toBe(BROKEN_PERMANENT_AFTER);
		// Exactly BROKEN_PERMANENT_AFTER spawns happened before give-up — the
		// breaker converged instead of respawning on every remaining iteration.
		expect(server.getSpawnCount()).toBe(BROKEN_PERMANENT_AFTER);

		// Further calls stay given-up: no new spawn, no new client.
		const spawnCountAtGiveUp = server.getSpawnCount();
		internal.state.broken.delete(key); // even if cooldown "elapses" again
		const after = await service.getClientForFile(file);
		expect(after).toBeUndefined();
		expect(server.getSpawnCount()).toBe(spawnCountAtGiveUp);
	});

	it("counts an early death even when DETECTION is delayed hours (death time, not detection time, decides)", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const internal = service as unknown as {
			state: {
				broken: Map<string, number>;
				clientSpawnedAt: Map<string, number>;
			};
			runtimeExitCounts: Map<string, number>;
			permanentlyBroken: Set<string>;
		};

		const server = makeSpawnServer("opengrep");
		getServersForFileWithConfig.mockReturnValue([server]);

		const client = makeFakeClient("opengrep");
		createLSPClient.mockResolvedValue(client);

		const file = "C:/repo/main.fake";
		// See header comment: key computed via normalizeMapKey, not hardcoded.
		const key = `opengrep:${normalizeMapKey("C:/repo")}`;

		const first = await service.getClientForFile(file);
		expect(first).toBeDefined();

		// Backdate the spawn to 3 hours ago and record death only 5s after that
		// — an early, breaker-worthy exit — but do NOT touch "now": this call's
		// getClientForFile happens in real time milliseconds later, modeling
		// detection arriving hours after the actual death (#1127's documented
		// attach-triggered respawn pattern). If lifetime were computed from
		// detection time instead of the recorded exitedAt, this would wrongly
		// read as a multi-hour healthy run and never count.
		const spawnedAtHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
		internal.state.clientSpawnedAt.set(key, spawnedAtHoursAgo);
		client.die(spawnedAtHoursAgo + 5_000);

		internal.state.broken.delete(key);
		const second = await service.getClientForFile(file);
		expect(second).toBeUndefined(); // cooldown was just set by the count below

		expect(internal.runtimeExitCounts.get(key)).toBe(1);
		expect(internal.permanentlyBroken.has(key)).toBe(false);
	});

	it("does NOT count a deliberate shutdown()-driven restart toward the breaker", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const internal = service as unknown as {
			state: { broken: Map<string, number> };
			runtimeExitCounts: Map<string, number>;
			permanentlyBroken: Set<string>;
		};

		const server = makeSpawnServer("opengrep");
		getServersForFileWithConfig.mockReturnValue([server]);

		const clients: Array<ReturnType<typeof makeFakeClient>> = [];
		createLSPClient.mockImplementation(async () => {
			const c = makeFakeClient("opengrep");
			clients.push(c);
			return c;
		});

		const file = "C:/repo/main.fake";
		// See header comment: key computed via normalizeMapKey, not hardcoded.
		const key = `opengrep:${normalizeMapKey("C:/repo")}`;

		// Simulate 8 deliberate restarts (well past BROKEN_PERMANENT_AFTER=5) —
		// e.g. a resync/reopen-style path that calls shutdown() itself before
		// the client goes dead. None of these should count as failures.
		for (let i = 0; i < 8; i++) {
			internal.state.broken.delete(key);
			const result = await service.getClientForFile(file);
			expect(result).toBeDefined();
			const last = clients.at(-1)!;
			// Deliberate: our own shutdown() marks it intentional (mirrors #743
			// notify-backpressure eviction / session reset paths), and only THEN
			// does the client go dead — matches the real ordering where
			// clientShutdown() sets shutdownRequested before the process exits.
			await last.shutdown();
			last.die();
		}

		expect(internal.runtimeExitCounts.get(key) ?? 0).toBe(0);
		expect(internal.permanentlyBroken.has(key)).toBe(false);
		expect(server.getSpawnCount()).toBe(8);
	});

	it("does not count a runtime exit whose lifetime is past the early-exit threshold", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const internal = service as unknown as {
			state: {
				broken: Map<string, number>;
				clientSpawnedAt: Map<string, number>;
			};
			runtimeExitCounts: Map<string, number>;
			permanentlyBroken: Set<string>;
		};

		const server = makeSpawnServer("opengrep");
		getServersForFileWithConfig.mockReturnValue([server]);

		const client = makeFakeClient("opengrep");
		createLSPClient.mockResolvedValue(client);

		const file = "C:/repo/main.fake";
		// See header comment: key computed via normalizeMapKey, not hardcoded.
		const key = `opengrep:${normalizeMapKey("C:/repo")}`;

		const first = await service.getClientForFile(file);
		expect(first).toBeDefined();

		// Died 5 minutes after spawning (well past the 60s early-exit
		// threshold) — a genuinely long, healthy run, not a crash loop.
		const spawnedAt = internal.state.clientSpawnedAt.get(key)!;
		client.die(spawnedAt + 5 * 60_000);

		internal.state.broken.delete(key);
		const second = await service.getClientForFile(file);
		expect(second).toBeDefined();

		expect(internal.runtimeExitCounts.get(key) ?? 0).toBe(0);
		expect(internal.permanentlyBroken.has(key)).toBe(false);
	});

	it("does NOT double-count the REAL #743 notify-backpressure eviction path", async () => {
		// #743's recordNotifyWriteBackpressure evicts a wedged client directly
		// (removes it from state.clients + calls its shutdown() + sets its own
		// cooldown) WITHOUT ever going through the "dead client — needs
		// respawn" branch this fix touches — by the time anything looks for an
		// existing client again, there simply isn't one. This drives the REAL
		// touchFile → notify-write-timeout → eviction path (not a synthetic
		// stand-in) and confirms it neither trips runtimeExitCounts nor gets
		// misread as a crash.
		const originalBudget = process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
		process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = "5";
		try {
			const { LSPService } = await import("../../../clients/lsp/index.js");
			const service = new LSPService();
			const internal = service as unknown as {
				state: { broken: Map<string, number>; clients: Map<string, unknown> };
				runtimeExitCounts: Map<string, number>;
				permanentlyBroken: Set<string>;
			};

			const server = makeSpawnServer("opengrep");
			getServersForFileWithConfig.mockReturnValue([server]);

			const client = makeFakeClient("opengrep");
			// Every notify.open write hangs forever — withDeadline's 5ms budget
			// times it out on every touchFile call, driving the backpressure
			// streak without needing to fake a stalled real process.
			client.notify.open = vi.fn().mockReturnValue(new Promise(() => {}));
			createLSPClient.mockResolvedValue(client);

			const file = "C:/repo/main.fake";
			// See header comment: key computed via normalizeMapKey, not hardcoded.
			const key = `opengrep:${normalizeMapKey("C:/repo")}`;

			// NOTIFY_BACKPRESSURE_BROKEN_AFTER = 3 consecutive timeouts evict.
			for (let i = 0; i < 3; i++) {
				await service.touchFile(file, `content-${i}`, {});
			}

			// Evicted via the REAL #743 path: removed from state.clients, its own
			// shutdown() called (marking it intentional), and state.broken set to
			// the base cooldown directly — none of that is this fix's counter.
			expect(internal.state.clients.has(key)).toBe(false);
			expect(client.shutdown).toHaveBeenCalled();
			expect(client.intentional).toBe(true);
			expect(internal.state.broken.has(key)).toBe(true);

			expect(internal.runtimeExitCounts.get(key) ?? 0).toBe(0);
			expect(internal.permanentlyBroken.has(key)).toBe(false);
		} finally {
			if (originalBudget === undefined) {
				delete process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
			} else {
				process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = originalBudget;
			}
		}
	});
});
