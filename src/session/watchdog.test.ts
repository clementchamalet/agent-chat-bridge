import { describe, expect, it, vi } from "vitest";
import { startWatchdog } from "./watchdog.js";
import { makeLogger } from "../utils/logger.js";

function fakeDeps(timeoutMinutes: number, maxTaskHours = 0) {
  return {
    sessionRepo: { listByState: vi.fn(() => []) } as never,
    ptyManager: { kill: vi.fn() } as never,
    sender: { sendText: vi.fn().mockResolvedValue(undefined) } as never,
    logger: makeLogger("error", "test"),
    timeoutMinutes,
    maxTaskHours,
  };
}

describe("startWatchdog", () => {
  it("does not schedule any interval when timeoutMinutes is 0", () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const stop = startWatchdog(fakeDeps(0));
    expect(setIntervalSpy).not.toHaveBeenCalled();
    stop();
    setIntervalSpy.mockRestore();
  });

  it("does not schedule any interval when timeoutMinutes is negative", () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const stop = startWatchdog(fakeDeps(-5));
    expect(setIntervalSpy).not.toHaveBeenCalled();
    stop();
    setIntervalSpy.mockRestore();
  });

  it("schedules an interval when timeoutMinutes is positive", () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const stop = startWatchdog(fakeDeps(30));
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    stop();
    setIntervalSpy.mockRestore();
  });

  it("stops a task that exceeds the configured duration", async () => {
    vi.useFakeTimers();
    try {
      const deps = fakeDeps(0, 1);
      const session = { jid: "tg:123", executionStartedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() };
      (deps.sessionRepo as { listByState: ReturnType<typeof vi.fn> }).listByState = vi.fn((state) =>
        state === "EXECUTING" ? [session] : [],
      );
      (deps.sessionRepo as { update: ReturnType<typeof vi.fn> }).update = vi.fn();
      const stop = startWatchdog(deps);
      await vi.advanceTimersByTimeAsync(60_000);
      expect((deps.ptyManager as { kill: ReturnType<typeof vi.fn> }).kill).toHaveBeenCalledWith("tg:123");
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
