import * as path from "node:path";
import { isTestMode } from "./env-utils.js";
import { getGlobalPiLensDir } from "./file-utils.js";
import { createNdjsonLogger } from "./ndjson-logger.js";
import { getMaxLogSizeMB } from "./log-cleanup.js";

const LATENCY_LOG_DIR = getGlobalPiLensDir();
const LATENCY_LOG_FILE = path.join(LATENCY_LOG_DIR, "latency.log");

const writer = createNdjsonLogger({
	filePath: LATENCY_LOG_FILE,
	maxBytes: getMaxLogSizeMB() * 1024 * 1024,
});

export interface LatencyEntry {
	type: "runner" | "tool_result" | "phase";
	/** ISO timestamp when this entry was written (= finish time for runners) */
	ts?: string;
	/** Process that wrote the entry; used to isolate current-session telemetry. */
	pid?: number;
	/** ISO timestamp when the runner/phase started — diff with ts = durationMs */
	startedAt?: string;
	toolName?: string;
	filePath: string;
	fullPath?: string;
	phase?: string;
	durationMs: number;
	totalDurationMs?: number;
	result?: string;
	runnerId?: string;
	status?: string;
	diagnosticCount?: number;
	semantic?: string;
	/** Per-diagnostic summary when a runner produces findings — aids root-cause analysis */
	diagnostics?: Array<{ rule?: string; message: string; line?: number; semantic?: string }>;
	/** For dispatch_complete: actual wall-clock time (groups run in parallel) */
	wallClockMs?: number;
	/** For dispatch_complete: sum of all individual runner durationMs */
	sumMs?: number;
	/** wallClockMs - sumMs ≥ 0 means parallelism saved this many ms */
	parallelGainMs?: number;
	metadata?: Record<string, unknown>;
}

/**
 * Most recent non-`loop_block` phase seen by `logLatency`, for cheap block
 * attribution (#1122 / #1123 item 1): the event-loop-block probe fires at
 * turn_end and cannot see *what* stalled the loop, so it stamps the last phase
 * that ran as a starting point for root-causing a genuine block. Tracked before
 * the test-mode guard so it is deterministic and unit-testable.
 */
let lastPhase: { phase: string; ts: string } | undefined;

/**
 * The last non-`loop_block` phase logged, or undefined if none yet. Carries its
 * own `ts` so a consumer can gauge staleness: it is intentionally NOT cleared at
 * turn/window boundaries, so on a turn that logged no phase of its own it may
 * point at a prior turn's phase — compare `ts` against the block time before
 * trusting it as the cause (it is a breadcrumb, not proof).
 */
export function getLastLoggedPhase(): { phase: string; ts: string } | undefined {
	return lastPhase;
}

export function logLatency(entry: LatencyEntry): void {
	const ts = new Date().toISOString();
	if (entry.type === "phase" && entry.phase && entry.phase !== "loop_block") {
		lastPhase = { phase: entry.phase, ts };
	}
	if (isTestMode()) {
		return;
	}
	writer.log({ ...entry, ts, pid: process.pid });
}

export function getLatencyLogPath(): string {
	return LATENCY_LOG_FILE;
}

/** Resolve once all enqueued latency writes are on disk (tests/shutdown). */
export function flushLatencyLog(): Promise<void> {
	return writer.flush();
}

export function clearLatencyLog(): void {
	// Enqueue the truncate in the same serialized queue so a clear cannot race a
	// pending drain. Await flushLatencyLog() if you need the file empty on disk.
	writer.truncate();
}
