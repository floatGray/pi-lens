/**
 * Tests for the periodic memory-attribution sample (#1123 item 2).
 *
 * `shouldEmitMemorySample`/`toMemoryProcessUsage`/`formatMemoryHealthLine` are
 * pure. `collectMemorySampleSubsystems`/`buildMemorySample` touch real
 * process-global singletons (the shared tree-sitter client, the review-graph
 * workspace cache, the dispatch cascade caches) — asserted structurally
 * (fields present, non-negative, `null` when the subsystem hasn't been
 * touched yet) rather than against exact values, since those singletons are
 * shared with the rest of the suite.
 */

import { describe, expect, it } from "vitest";
import {
	buildMemorySample,
	collectMemorySampleSubsystems,
	formatMemoryHealthLine,
	MEMORY_SAMPLE_TURN_INTERVAL,
	shouldEmitMemorySample,
	toMemoryProcessUsage,
} from "../../clients/memory-sampler.js";
import { getReviewGraphWorkspaceCacheSnapshot } from "../../clients/review-graph/builder.js";
import { getDispatchCascadeCacheStats } from "../../clients/dispatch/integration.js";
import type { WordIndex } from "../../clients/word-index.js";
import { PathKeyedMap } from "../../clients/path-keyed-map.js";
import { normalizeEphemeralMapKey } from "../../clients/path-utils.js";

describe("shouldEmitMemorySample (cadence)", () => {
	it("is false on turn 0 (nothing meaningful resident yet)", () => {
		expect(shouldEmitMemorySample(0)).toBe(false);
	});

	it(`is true exactly every ${MEMORY_SAMPLE_TURN_INTERVAL} turns`, () => {
		expect(shouldEmitMemorySample(MEMORY_SAMPLE_TURN_INTERVAL)).toBe(true);
		expect(shouldEmitMemorySample(MEMORY_SAMPLE_TURN_INTERVAL * 3)).toBe(true);
	});

	it("is false on every other turn", () => {
		for (let t = 1; t < MEMORY_SAMPLE_TURN_INTERVAL; t++) {
			expect(shouldEmitMemorySample(t)).toBe(false);
		}
		expect(shouldEmitMemorySample(MEMORY_SAMPLE_TURN_INTERVAL + 1)).toBe(false);
	});
});

describe("toMemoryProcessUsage (pure reshape)", () => {
	it("maps every process.memoryUsage() field to this module's names", () => {
		const mem: NodeJS.MemoryUsage = {
			rss: 100,
			heapTotal: 80,
			heapUsed: 60,
			external: 20,
			arrayBuffers: 10,
		};
		expect(toMemoryProcessUsage(mem)).toEqual({
			rssBytes: 100,
			heapTotalBytes: 80,
			heapUsedBytes: 60,
			externalBytes: 20,
			arrayBuffersBytes: 10,
		});
	});
});

function fakeMem(overrides: Partial<NodeJS.MemoryUsage> = {}): NodeJS.MemoryUsage {
	return {
		rss: 300 * 1024 * 1024,
		heapTotal: 150 * 1024 * 1024,
		heapUsed: 100 * 1024 * 1024,
		external: 20 * 1024 * 1024,
		arrayBuffers: 10 * 1024 * 1024,
		...overrides,
	};
}

describe("collectMemorySampleSubsystems (O(1)/O(bounded-cache-size) live reads)", () => {
	it("wordIndex is null when none is supplied (no word index built yet this session)", () => {
		const subsystems = collectMemorySampleSubsystems(null);
		expect(subsystems.wordIndex).toBeNull();
	});

	it("reports word-index doc/posting/forward counts when a word index is supplied", () => {
		const wordIndex: WordIndex = {
			postings: new Map([["foo", [{ file: "a.ts", line: 1 }]]]),
			docLengths: (() => {
				const m = new PathKeyedMap<number>(normalizeEphemeralMapKey);
				m.set("a.ts", 5);
				return m;
			})(),
			forward: (() => {
				const m = new PathKeyedMap<Map<string, number>>(normalizeEphemeralMapKey);
				m.set("a.ts", new Map([["foo", 1]]));
				return m;
			})(),
			totalTokens: 5,
			docCount: 1,
			fileMtimes: new PathKeyedMap<number>(normalizeEphemeralMapKey),
			fileSizes: new PathKeyedMap<number>(normalizeEphemeralMapKey),
		};
		const subsystems = collectMemorySampleSubsystems(wordIndex);
		expect(subsystems.wordIndex).toEqual({ docs: 1, postings: 1, forwardEntries: 1 });
	});

	it("reviewGraph/dispatchCaches mirror the live accessors exactly (no extra reads)", () => {
		const subsystems = collectMemorySampleSubsystems(null);
		expect(subsystems.reviewGraph).toEqual(getReviewGraphWorkspaceCacheSnapshot());
		expect(subsystems.dispatchCaches).toEqual(getDispatchCascadeCacheStats());
	});

	it("every numeric field is non-negative and finite (plausibility, not exact values)", () => {
		const subsystems = collectMemorySampleSubsystems(null);
		expect(subsystems.reviewGraph.cacheEntries).toBeGreaterThanOrEqual(0);
		expect(subsystems.reviewGraph.totalNodes).toBeGreaterThanOrEqual(0);
		expect(subsystems.reviewGraph.totalEdges).toBeGreaterThanOrEqual(0);
		expect(subsystems.dispatchCaches.neighborTouchCacheSize).toBeGreaterThanOrEqual(0);
		expect(subsystems.dispatchCaches.recentlyCleanNeighborCacheSize).toBeGreaterThanOrEqual(0);
		if (subsystems.treeSitter) {
			expect(subsystems.treeSitter.languagesLoaded).toBeGreaterThanOrEqual(0);
			expect(subsystems.treeSitter.treeCacheTotalBytes).toBeGreaterThanOrEqual(0);
		}
	});
});

describe("buildMemorySample", () => {
	it("assembles process + subsystems from an injected memoryUsage reading", () => {
		const sample = buildMemorySample(null, fakeMem());
		expect(sample.process.rssBytes).toBe(300 * 1024 * 1024);
		expect(sample.subsystems).toBeDefined();
	});
});

describe("formatMemoryHealthLine (pure)", () => {
	it("renders RSS/heap/external in MB and the review-graph counts", () => {
		const sample = buildMemorySample(null, fakeMem());
		const line = formatMemoryHealthLine(sample);
		expect(line).toContain("Memory: RSS 300MB");
		expect(line).toContain("heap 100/150MB");
		expect(line).toContain("external 20MB");
		expect(line).toMatch(/review-graph \d+n\/\d+e \(\d+ cwd\)/);
	});

	it("renders 'n/a' for tree-sitter when the shared client was never touched (subsystem is null)", () => {
		const sample = buildMemorySample(null, fakeMem());
		// Force the null-subsystem branch directly (doesn't depend on suite ordering
		// of whether some other test already initialized the shared client).
		sample.subsystems.treeSitter = null;
		const line = formatMemoryHealthLine(sample);
		expect(line).toContain("tree-sitter cache n/a");
	});
});
