import { afterEach, describe, expect, it } from "vitest";
import {
	_stopEventLoopMonitorForTest,
	getEventLoopStats,
	isSuspendSuspectedBlock,
	resetEventLoopMonitor,
	shouldLogWorstBlock,
	startEventLoopMonitor,
} from "../../clients/event-loop-monitor.js";

// Note: the actual *capture* of a synchronous block is Node's native
// `monitorEventLoopDelay` (its libuv timer is unreliable inside vitest's worker,
// but verified manually: a 200ms busy-loop yields max≈200ms on a live loop).
// These cover our wrapper's contract — lifecycle, finite-stat conversion, reset.

afterEach(() => {
	_stopEventLoopMonitorForTest();
});

const settle = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("event-loop-monitor", () => {
	it("returns undefined before it is started", () => {
		expect(getEventLoopStats()).toBeUndefined();
	});

	it("reports finite occupancy stats once started", async () => {
		startEventLoopMonitor(10);
		await settle(40); // let it sample a few intervals
		const s = getEventLoopStats();
		expect(s).toBeDefined();
		expect(Number.isFinite(s?.maxMs)).toBe(true);
		expect(Number.isFinite(s?.p99Ms)).toBe(true);
		expect(Number.isFinite(s?.meanMs)).toBe(true);
		expect(s?.maxMs).toBeGreaterThanOrEqual(0);
	});

	it("exposes per-window CPU/wall accounting and a stall flag (#1122)", async () => {
		startEventLoopMonitor(10);
		await settle(40);
		const s = getEventLoopStats();
		expect(Number.isFinite(s?.windowWallMs)).toBe(true);
		expect(Number.isFinite(s?.windowCpuMs)).toBe(true);
		expect(s?.windowWallMs).toBeGreaterThanOrEqual(0);
		expect(s?.windowCpuMs).toBeGreaterThanOrEqual(0);
		// A live loop with a real (tiny) block is never a system stall.
		expect(s?.suspectSystemStall).toBe(false);
	});

	it("reset does not throw and keeps stats queryable", async () => {
		startEventLoopMonitor(10);
		await settle(20);
		resetEventLoopMonitor();
		expect(getEventLoopStats()).toBeDefined();
	});

	it("start is idempotent", () => {
		startEventLoopMonitor();
		startEventLoopMonitor();
		expect(getEventLoopStats()).toBeDefined();
	});

	it("_stopEventLoopMonitorForTest clears the monitor", () => {
		startEventLoopMonitor();
		expect(getEventLoopStats()).toBeDefined();
		_stopEventLoopMonitorForTest();
		expect(getEventLoopStats()).toBeUndefined();
	});
});

describe("shouldLogWorstBlock", () => {
	it("logs a new worst block above the floor", () => {
		expect(shouldLogWorstBlock(200, 0)).toBe(true);
	});

	it("does not log a block below the floor", () => {
		expect(shouldLogWorstBlock(40, 0)).toBe(false);
	});

	it("does not re-log a block within delta of the last logged max", () => {
		expect(shouldLogWorstBlock(210, 200)).toBe(false); // 210 ≤ 200+25
	});

	it("logs a clearly worse block beyond the delta", () => {
		expect(shouldLogWorstBlock(300, 200)).toBe(true); // 300 > 225
	});
});

describe("isSuspendSuspectedBlock (system-stall discrimination, #1122)", () => {
	it("flags a huge block the window's CPU cannot account for (sleep/paging)", () => {
		// 290s block, ~0.3s of CPU in the window → the process was frozen.
		expect(isSuspendSuspectedBlock(290179, 300)).toBe(true);
	});

	it("does not flag a large block backed by matching CPU (genuine CPU stall)", () => {
		// A real 30s synchronous burst burns ~30s of main-thread CPU.
		expect(isSuspendSuspectedBlock(30000, 30000)).toBe(false);
	});

	it("never flags blocks below the floor, even with low CPU (protects the real tier)", () => {
		// A genuine 10.6s I/O-bound block with little CPU must stay 'real'.
		expect(isSuspendSuspectedBlock(10595, 50)).toBe(false);
	});

	it("respects the CPU slop so a near-match is not flagged", () => {
		expect(isSuspendSuspectedBlock(25000, 24500)).toBe(false); // within 1s slop
		expect(isSuspendSuspectedBlock(25000, 20000)).toBe(true); // 5s unaccounted
	});
});

describe("resetEventLoopMonitor window re-baselining (#1122)", () => {
	it("resets the wall window so a fresh turn measures a much smaller elapsed span", async () => {
		startEventLoopMonitor(10);
		await settle(60);
		const before = getEventLoopStats()?.windowWallMs ?? 0;
		expect(before).toBeGreaterThanOrEqual(40);
		resetEventLoopMonitor();
		const after = getEventLoopStats()?.windowWallMs ?? Number.POSITIVE_INFINITY;
		// Relative, not an absolute bound: a GC pause between reset and read can
		// inflate the fresh window on a loaded CI box, so assert only that reset
		// cut it well below the pre-reset elapsed span.
		expect(after).toBeLessThan(before / 2);
	});
});
