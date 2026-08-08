import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPiMock } from "./support/pi-mock.js";

// Wiring guards for the #1122 loop_block probe fix. These live at the index.ts
// turn_end seam (not the pure classifier) because the two things that broke —
// and could silently re-break in a refactor — are wiring facts:
//   (a) turn_end MUST call resetEventLoopMonitor(); the headline bug was that
//       reset was NEVER wired, so histogram.max was lifetime-cumulative.
//   (b) a suspectSystemStall sample MUST NOT advance the genuine-block
//       high-water, or a machine freeze permanently silences later real blocks.
// Both fail on pre-fix master: (a) master never calls reset; (b) master raises
// the high-water unconditionally, so the follow-up genuine block is suppressed.

// Controllable event-loop stats + spyable reset. shouldLogWorstBlock stays real
// so the gating logic under test is the production one.
let statsToReturn: unknown;
const resetSpy = vi.fn();
vi.mock("../clients/event-loop-monitor.js", async (importActual) => {
	const actual = await importActual<typeof import("../clients/event-loop-monitor.js")>();
	return {
		...actual,
		startEventLoopMonitor: vi.fn(),
		resetEventLoopMonitor: resetSpy,
		getEventLoopStats: () => statsToReturn,
	};
});

// Capture latency writes without touching disk; provide the attribution seam.
const latencyCalls: Array<Record<string, unknown>> = [];
vi.mock("../clients/latency-logger.js", async (importActual) => {
	const actual = await importActual<typeof import("../clients/latency-logger.js")>();
	return {
		...actual,
		logLatency: (entry: Record<string, unknown>) => {
			latencyCalls.push(entry);
		},
		getLastLoggedPhase: () => ({ phase: "graph_build", ts: "2026-08-07T00:00:00.000Z" }),
	};
});

// Heavy turn_end tail is separately tested; stub to keep this a wiring check.
vi.mock("../clients/bootstrap.js", () => ({
	loadBootstrapClients: async () => ({
		metricsClient: { reset: () => {} },
		knipClient: { isAvailable: () => false },
		depChecker: { isAvailable: () => false },
		testRunnerClient: { detectRunner: () => null },
		deadCodeClients: {},
	}),
}));
vi.mock("../clients/runtime-turn.js", () => ({
	handleTurnEnd: vi.fn(async () => undefined),
	cancelLSPIdleReset: vi.fn(),
}));

const loopBlocks = () => latencyCalls.filter((e) => e.phase === "loop_block");

const turnCtx = {
	cwd: process.cwd(),
	ui: {
		notify: vi.fn(),
		setStatus: () => {},
		theme: { fg: (_c: string, s: string) => s },
	},
};

async function fireTurnEnd() {
	const { default: registerExtension } = await import("../index.ts");
	const mock = createPiMock({ "lens-lsp": true });
	registerExtension(mock.asExtensionAPI() as never);
	const turnEnd = mock.getHandlers("turn_end")[0];
	expect(turnEnd).toBeTypeOf("function");
	await turnEnd?.({}, turnCtx as never);
	return mock;
}

describe("index turn_end loop_block wiring (#1122)", () => {
	beforeEach(() => {
		vi.resetModules();
		latencyCalls.length = 0;
		resetSpy.mockClear();
		statsToReturn = undefined;
	});
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("(a) calls resetEventLoopMonitor at turn_end so the window is per-turn", async () => {
		statsToReturn = {
			maxMs: 0,
			p99Ms: 0,
			meanMs: 0,
			windowWallMs: 0,
			windowCpuMs: 0,
			suspectSystemStall: false,
		};
		await fireTurnEnd();
		// Fails on master: master's turn_end never resets the histogram.
		expect(resetSpy).toHaveBeenCalledTimes(1);
	});

	it("(b) a suspectSystemStall block does not raise the high-water, so a later genuine block still logs", async () => {
		// resetModules is per-test, so re-import once and drive two turns against
		// the SAME module instance to exercise the cross-turn high-water.
		const { default: registerExtension } = await import("../index.ts");
		const mock = createPiMock({ "lens-lsp": true });
		registerExtension(mock.asExtensionAPI() as never);
		const turnEnd = mock.getHandlers("turn_end")[0];

		// Turn 1: a 300s "block" tagged as a system stall.
		statsToReturn = {
			maxMs: 300000,
			p99Ms: 0,
			meanMs: 0,
			windowWallMs: 300000,
			windowCpuMs: 200,
			suspectSystemStall: true,
		};
		await turnEnd?.({}, turnCtx as never);

		// Turn 2: a genuine 5s block, far below the stall but a real worst.
		statsToReturn = {
			maxMs: 5000,
			p99Ms: 0,
			meanMs: 0,
			windowWallMs: 8000,
			windowCpuMs: 6000,
			suspectSystemStall: false,
		};
		await turnEnd?.({}, turnCtx as never);

		const logged = loopBlocks();
		// The stall logged (tagged) but did NOT poison the high-water, so the
		// genuine 5s block logged too. On master the stall sets the high-water to
		// 300000 and the 5s block is suppressed → only ONE loop_block.
		expect(logged).toHaveLength(2);
		expect(logged[0].durationMs).toBe(300000);
		expect((logged[0].metadata as Record<string, unknown>).suspectSystemStall).toBe(true);
		expect(logged[1].durationMs).toBe(5000);
		expect((logged[1].metadata as Record<string, unknown>).suspectSystemStall).toBe(false);
		// Attribution is carried through.
		expect((logged[1].metadata as Record<string, unknown>).lastPhase).toBe("graph_build");
	});
});
