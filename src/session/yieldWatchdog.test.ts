import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArbitrationTarget } from "./arbitration.js";
import type { SessionRecord } from "../types.js";
import { liveSessionName } from "../pty/tmux.js";

vi.mock("../discovery/externalProcess.js", () => ({
  findExternalResumeProcesses: vi.fn(() => []),
  getCpuTimeSeconds: vi.fn(() => 0),
}));

import { findExternalResumeProcesses, getCpuTimeSeconds } from "../discovery/externalProcess.js";
import { startYieldWatchdog } from "./yieldWatchdog.js";
import { makeLogger } from "../utils/logger.js";

const JID = "yield-test-jid";

function fakeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    jid: JID,
    workingDir: "/tmp/project",
    engine: "claude",
    model: null,
    effort: null,
    state: "IDLE",
    ptyPid: 123,
    waitingSince: null,
    tmuxSession: liveSessionName("claude", "some-resume-id"),
    resumeId: "some-resume-id",
    title: null,
    started: true,
    verbose: false,
    resolvedModel: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function fakeDeps(sessions: SessionRecord[]) {
  const arbitrations: { jid: string; target: ArbitrationTarget; elsewherePids: number[] }[] = [];
  const sentTexts: string[] = [];
  const deps = {
    sessionRepo: {
      listAll: vi.fn(() => sessions),
      update: vi.fn(),
    },
    ptyManager: {
      isAlive: vi.fn(() => true),
      kill: vi.fn(),
    },
    sender: {
      sendText: vi.fn(async (_jid: string, text: string) => {
        sentTexts.push(text);
      }),
    },
    logger: makeLogger("error", "test"),
    presentArbitration: vi.fn(async (jid: string, target: ArbitrationTarget, elsewherePids: number[]) => {
      arbitrations.push({ jid, target, elsewherePids });
    }),
  };
  return { deps: deps as never as Parameters<typeof startYieldWatchdog>[0], raw: deps, arbitrations, sentTexts };
}

function mockGrowingCpuTime(perTick: number): void {
  let total = 0;
  vi.mocked(getCpuTimeSeconds).mockImplementation(() => {
    total += perTick;
    return total;
  });
}

describe("startYieldWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(findExternalResumeProcesses).mockReset();
    vi.mocked(getCpuTimeSeconds).mockReset().mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not arbitrate merely because a matching process exists but is idle (~0 CPU growth) — an open-but-unused Desktop tab", () => {
    vi.mocked(findExternalResumeProcesses).mockReturnValue([999]);
    vi.mocked(getCpuTimeSeconds).mockReturnValue(12.3);
    const { deps, arbitrations } = fakeDeps([fakeSession()]);

    const watchdog = startYieldWatchdog(deps);
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);

    expect(arbitrations).toEqual([]);
    watchdog.stop();
  });

  it("does not arbitrate on the first sighting even with CPU growth — no baseline to compare against yet", () => {
    mockGrowingCpuTime(2);
    vi.mocked(findExternalResumeProcesses).mockReturnValue([999]);
    const { deps, arbitrations } = fakeDeps([fakeSession()]);

    const watchdog = startYieldWatchdog(deps);
    vi.advanceTimersByTime(30_000);

    expect(arbitrations).toEqual([]);
    watchdog.stop();
  });

  it("raises the arbitration after two consecutive checks showing real CPU growth, instead of silently yielding", () => {
    mockGrowingCpuTime(2);
    vi.mocked(findExternalResumeProcesses).mockReturnValue([999]);
    const { deps, arbitrations, raw } = fakeDeps([fakeSession()]);

    const watchdog = startYieldWatchdog(deps);
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);

    expect(arbitrations).toHaveLength(1);
    expect(arbitrations[0]).toMatchObject({
      jid: JID,
      target: { engine: "claude", resumeId: "some-resume-id", live: true },
      elsewherePids: [999],
    });
    expect(raw.ptyManager.kill).not.toHaveBeenCalled();
    watchdog.stop();
  });

  it("resets the active streak if a check in between shows no growth", () => {
    vi.mocked(findExternalResumeProcesses).mockReturnValue([999]);
    const { deps, arbitrations } = fakeDeps([fakeSession()]);
    const cpu = [0, 2, 2, 4, 4];
    let i = 0;
    vi.mocked(getCpuTimeSeconds).mockImplementation(() => cpu[Math.min(i++, cpu.length - 1)]!);

    const watchdog = startYieldWatchdog(deps);
    for (let t = 0; t < cpu.length; t++) vi.advanceTimersByTime(30_000);

    expect(arbitrations).toEqual([]);
    watchdog.stop();
  });

  it("resets tracking entirely when the external process disappears", () => {
    vi.mocked(findExternalResumeProcesses)
      .mockReturnValueOnce([999])
      .mockReturnValueOnce([999])
      .mockReturnValueOnce([])
      .mockReturnValue([999]);
    mockGrowingCpuTime(2);
    const { deps, arbitrations } = fakeDeps([fakeSession()]);

    const watchdog = startYieldWatchdog(deps);
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);

    expect(arbitrations).toEqual([]);
    watchdog.stop();
  });

  it("skips a brand-new conversation that has no resumeId yet", () => {
    vi.mocked(findExternalResumeProcesses).mockReturnValue([999]);
    const { deps, arbitrations } = fakeDeps([fakeSession({ resumeId: null, started: false })]);

    const watchdog = startYieldWatchdog(deps);
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);

    expect(arbitrations).toEqual([]);
    expect(findExternalResumeProcesses).not.toHaveBeenCalled();
    watchdog.stop();
  });

  it("skips a session that isn't actually alive in the pty manager", () => {
    vi.mocked(findExternalResumeProcesses).mockReturnValue([999]);
    mockGrowingCpuTime(2);
    const { deps, raw, arbitrations } = fakeDeps([fakeSession()]);
    raw.ptyManager.isAlive.mockReturnValue(false);

    const watchdog = startYieldWatchdog(deps);
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(30_000);

    expect(arbitrations).toEqual([]);
    watchdog.stop();
  });

  describe("watchForFree (leave control on Mac)", () => {
    const target: ArbitrationTarget = {
      engine: "claude",
      resumeId: "watched-id",
      directory: "/tmp/project",
      tmuxSession: "wa-claude-watched-id",
      title: "Fix footer",
      live: false,
    };

    it("pings once the watched target is no longer active elsewhere", () => {
      vi.mocked(findExternalResumeProcesses).mockReturnValueOnce([999]).mockReturnValueOnce([]);
      const { deps, sentTexts } = fakeDeps([]);

      const watchdog = startYieldWatchdog(deps);
      watchdog.watchForFree(JID, target);

      vi.advanceTimersByTime(30_000);
      expect(sentTexts).toEqual([]);

      vi.advanceTimersByTime(30_000);
      expect(sentTexts.some((t) => t.includes("Fix footer"))).toBe(true);
      watchdog.stop();
    });

    it("only pings once, not on every subsequent check", () => {
      vi.mocked(findExternalResumeProcesses).mockReturnValue([]);
      const { deps, sentTexts } = fakeDeps([]);

      const watchdog = startYieldWatchdog(deps);
      watchdog.watchForFree(JID, target);

      vi.advanceTimersByTime(30_000);
      vi.advanceTimersByTime(30_000);
      vi.advanceTimersByTime(30_000);

      expect(sentTexts).toHaveLength(1);
      watchdog.stop();
    });
  });
});
