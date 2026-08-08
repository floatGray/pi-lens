/**
 * #1109 — `safeSpawnAsync`'s non-Windows `killTree` else-branch (clients/safe-spawn.ts,
 * around the `child.kill("SIGTERM")` / `setTimeout(..., 1000)` pair) arms a REF'D
 * 1s SIGTERM→SIGKILL escalation timer that was neither cleared on child exit nor
 * unref'd. Flagged by PR #1110's adversarial review as the same defect shape as
 * #1097's LSP client-wait leak — an operation raced/bounded by an independently
 * armed timer whose loser (here: "the child already exited, SIGKILL was never
 * needed") is never cancelled. Bounded to 1s and only on kill paths, so it can't
 * reproduce #1097's hang by itself, but it's the same uncleared-race-timeout
 * class and leaves a ref'd handle pending for up to 1s after the child (and the
 * safeSpawnAsync call) has already settled.
 *
 * The branch under test is non-Windows-only. This suite runs on any host OS
 * (including Windows dev machines and Linux CI) by mocking `process.platform`
 * to force the non-Windows path — the same technique already used by
 * tests/clients/lsp/kill-process-tree.test.ts for the analogous LSP-teardown
 * escalation timer — and by mocking `node:child_process`'s `spawn` so no real
 * OS process/signal is involved (per AGENTS.md's OS-agnostic discipline: probe
 * behavior, don't assume one OS, and never let a platform-gated test vacuously
 * pass).
 *
 * Isolates the escalation timer specifically (rather than asserting a blanket
 * `vi.getTimerCount() === 0`) by filtering `setTimeout` calls to the exact
 * 1000ms delay hardcoded at the call site — the concurrently-armed main
 * `timeout` guard (30000ms in this test) and the best-effort resource sampler
 * (a `setInterval`, not `setTimeout`) can't collide with that filter.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (...args: unknown[]) => void;

function makeFakeChild(pid = 4242) {
	const listeners: Record<string, Listener[]> = {};
	const child = {
		pid,
		killed: false,
		kill: vi.fn(() => {
			child.killed = true;
			return true;
		}),
		on: vi.fn((event: string, listener: Listener) => {
			(listeners[event] ??= []).push(listener);
			return child;
		}),
		removeListener: vi.fn(),
		stdout: { setEncoding: vi.fn(), on: vi.fn() },
		stderr: { setEncoding: vi.fn(), on: vi.fn() },
		emit(event: string, ...args: unknown[]) {
			for (const l of listeners[event] ?? []) l(...args);
		},
	};
	return child;
}

const spawnMock = vi.fn();
vi.mock("node:child_process", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: spawnMock };
});

const { safeSpawnAsync, setAmbientAbortSignal } = await import(
	"../../clients/safe-spawn.js"
);

describe("safeSpawnAsync — non-Windows kill escalation timer cleanup (#1109)", () => {
	const realPlatform = process.platform;

	beforeEach(() => {
		spawnMock.mockReset();
		Object.defineProperty(process, "platform", {
			value: "linux",
			configurable: true,
		});
		vi.useFakeTimers();
	});

	afterEach(() => {
		Object.defineProperty(process, "platform", {
			value: realPlatform,
			configurable: true,
		});
		setAmbientAbortSignal(undefined);
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("clears the 1s escalation timer once the child exits, instead of leaving it pending", async () => {
		const child = makeFakeChild();
		spawnMock.mockReturnValue(child);

		const escalationHandles: unknown[] = [];
		const clearedHandles = new Set<unknown>();
		const realSetTimeout = global.setTimeout;
		const realClearTimeout = global.clearTimeout;
		vi.spyOn(global, "setTimeout").mockImplementation(
			((fn: Listener, ms?: number, ...args: unknown[]) => {
				const handle = realSetTimeout(fn as never, ms, ...args);
				if (ms === 1000) escalationHandles.push(handle);
				return handle;
			}) as typeof setTimeout,
		);
		vi.spyOn(global, "clearTimeout").mockImplementation(
			((handle: Parameters<typeof clearTimeout>[0]) => {
				clearedHandles.add(handle);
				return realClearTimeout(handle);
			}) as typeof clearTimeout,
		);

		const controller = new AbortController();
		const resultPromise = safeSpawnAsync("fake-cmd", [], {
			signal: controller.signal,
			timeout: 30_000,
		});

		// The Promise executor (spawn + listener registration + abort-signal
		// wiring) runs synchronously during construction, so the abort listener
		// is already attached here.
		controller.abort();

		// killTree's non-Windows branch (child.kill("SIGTERM") + the 1s
		// escalation setTimeout) runs synchronously off the abort listener —
		// no await point precedes it.
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		expect(escalationHandles.length).toBe(1);
		const escalationHandle = escalationHandles[0];
		expect(clearedHandles.has(escalationHandle)).toBe(false);

		// The child actually exits from SIGTERM alone — SIGKILL is never
		// needed, so the escalation timer's callback never fires.
		child.killed = true;
		child.emit("close", null, "SIGTERM");
		const result = await resultPromise;

		expect(result.failure).toBe("aborted");
		// Core assertion: pre-fix, killTree's escalation timer handle was never
		// stored, so nothing could clear it here — it stayed a REF'D pending
		// timer for the remaining ~1s after the child (and this call) had
		// already settled. Post-fix, the close handler clears it alongside the
		// already-cleared main `timeoutId`.
		expect(clearedHandles.has(escalationHandle)).toBe(true);
	});

	it("clears the escalation timer on the child's error path too", async () => {
		const child = makeFakeChild();
		spawnMock.mockReturnValue(child);

		const escalationHandles: unknown[] = [];
		const clearedHandles = new Set<unknown>();
		const realSetTimeout = global.setTimeout;
		const realClearTimeout = global.clearTimeout;
		vi.spyOn(global, "setTimeout").mockImplementation(
			((fn: Listener, ms?: number, ...args: unknown[]) => {
				const handle = realSetTimeout(fn as never, ms, ...args);
				if (ms === 1000) escalationHandles.push(handle);
				return handle;
			}) as typeof setTimeout,
		);
		vi.spyOn(global, "clearTimeout").mockImplementation(
			((handle: Parameters<typeof clearTimeout>[0]) => {
				clearedHandles.add(handle);
				return realClearTimeout(handle);
			}) as typeof clearTimeout,
		);

		const controller = new AbortController();
		const resultPromise = safeSpawnAsync("fake-cmd", [], {
			signal: controller.signal,
			timeout: 30_000,
		});
		controller.abort();

		expect(escalationHandles.length).toBe(1);
		const escalationHandle = escalationHandles[0];

		// The child never gets a clean "close" — instead the underlying spawn
		// reports an error (e.g. ESRCH racing the kill). The escalation timer
		// must still be cleared, not just on the happy "close" path.
		child.emit("error", new Error("kill raced an already-gone process"));
		const result = await resultPromise;

		expect(result.error).toBeInstanceOf(Error);
		expect(clearedHandles.has(escalationHandle)).toBe(true);
	});

	// #1114: the escalation callback itself was dead code — it checked
	// `!child.killed`, but Node sets `child.killed = true` the moment
	// `kill()` SENDS a signal (not when the child actually dies), so
	// immediately after the `child.kill("SIGTERM")` one line above, the
	// guard is always false and `child.kill("SIGKILL")` can never run. This
	// is the "escalation fires" case the timer-cleanup tests above don't
	// cover: they only ever emit "close"/"error" before the 1s mark, so the
	// callback's *body* never executes in those tests. Here the child
	// ignores SIGTERM outright (no close/error emitted at all) and we
	// advance the fake clock past 1000ms — pre-fix this assertion fails
	// because SIGKILL is never sent; post-fix (`!closed` gating, closed only
	// flips true from an observed close/error) it fires as designed.
	it("escalates SIGTERM to SIGKILL at the 1s mark when the child ignores SIGTERM (#1114)", async () => {
		const child = makeFakeChild();
		spawnMock.mockReturnValue(child);

		const controller = new AbortController();
		const resultPromise = safeSpawnAsync("fake-cmd", [], {
			signal: controller.signal,
			timeout: 30_000,
		});
		controller.abort();

		// killTree's non-Windows branch runs synchronously off the abort
		// listener: SIGTERM is sent and the 1s escalation timer is armed.
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");

		// The child never emits "close" or "error" — it ignores SIGTERM.
		// Advancing past the 1s escalation window must send SIGKILL.
		await vi.advanceTimersByTimeAsync(1000);
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");

		// Let the child actually die now so the pending promise settles and
		// the test can complete cleanly.
		child.killed = true;
		child.emit("close", null, "SIGKILL");
		const result = await resultPromise;
		expect(result.failure).toBe("aborted");
	});
});
