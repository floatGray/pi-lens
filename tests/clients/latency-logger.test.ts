import { beforeEach, describe, expect, it, vi } from "vitest";

const writerLog = vi.hoisted(() => vi.fn());

vi.mock("../../clients/env-utils.js", () => ({ isTestMode: () => false }));
vi.mock("../../clients/ndjson-logger.js", () => ({
	createNdjsonLogger: () => ({
		log: writerLog,
		append: vi.fn(),
		truncate: vi.fn(),
		flush: vi.fn().mockResolvedValue(undefined),
		flushSync: vi.fn(),
	}),
}));

import { getLastLoggedPhase, logLatency } from "../../clients/latency-logger.js";

describe("latency-logger", () => {
	beforeEach(() => {
		writerLog.mockClear();
	});

	it("owns process and timestamp attribution instead of trusting caller fields", () => {
		logLatency({
			type: "phase",
			phase: "test",
			filePath: "fixture.ts",
			durationMs: 10,
			pid: -1,
			ts: "2000-01-01T00:00:00.000Z",
		});

		expect(writerLog).toHaveBeenCalledTimes(1);
		expect(writerLog.mock.calls[0][0]).toEqual(
			expect.objectContaining({
				phase: "test",
				pid: process.pid,
				ts: expect.not.stringContaining("2000-01-01"),
			}),
		);
	});
});

describe("getLastLoggedPhase (loop_block attribution, #1122/#1123)", () => {
	it("tracks the most recent phase entry", () => {
		logLatency({ type: "phase", phase: "graph_build", filePath: "<x>", durationMs: 5 });
		const last = getLastLoggedPhase();
		expect(last?.phase).toBe("graph_build");
		expect(last?.ts).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
	});

	it("does not record loop_block itself as the last phase (no self-attribution)", () => {
		logLatency({ type: "phase", phase: "word_index_build", filePath: "<x>", durationMs: 5 });
		logLatency({ type: "phase", phase: "loop_block", filePath: "<pi-lens>", durationMs: 9000 });
		expect(getLastLoggedPhase()?.phase).toBe("word_index_build");
	});

	it("ignores non-phase entries", () => {
		logLatency({ type: "phase", phase: "cascade", filePath: "<x>", durationMs: 1 });
		logLatency({ type: "runner", filePath: "a.ts", durationMs: 1, runnerId: "biome" });
		expect(getLastLoggedPhase()?.phase).toBe("cascade");
	});
});
