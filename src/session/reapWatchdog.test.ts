import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeSessionRegistryEntry } from "../discovery/sessionRegistry.js";
import type { SessionRecord } from "../types.js";
import { liveSessionName } from "../pty/tmux.js";

const execFileSyncMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

vi.mock("../discovery/externalProcess.js", () => ({
  getCpuTimeSeconds: vi.fn(() => 0),
  killProcess: vi.fn(() => true),
}));

vi.mock("../discovery/sessionRegistry.js", () => ({
  readClaudeSessionRegistry: vi.fn(() => []),
  isPidAlive: vi.fn(() => true),
}));

import { getCpuTimeSeconds, killProcess } from "../discovery/externalProcess.js";
import { isPidAlive, readClaudeSessionRegistry } from "../discovery/sessionRegistry.js";
import { startReapWatchdog } from "./reapWatchdog.js";
import { makeLogger } from "../utils/logger.js";

const CHECK_INTERVAL_MS = 30 * 60_000;
const HOURS_48_TICKS = Math.ceil((48 * 60 * 60_000) / CHECK_INTERVAL_MS) + 1;

const JID = "reap-test-jid";
const TMUX_SESSION = liveSessionName("claude", "reap-resume-id");

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
    tmuxSession: TMUX_SESSION,
    resumeId: "reap-resume-id",
    title: null,
    started: true,
    verbose: false,
    resolvedModel: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function fakeDeps(sessions: SessionRecord[], idleHours = 48) {
  const deps = {
    sessionRepo: {
      listAll: vi.fn(() => sessions),
      setState: vi.fn(),
    },
    ptyManager: {
      isAlive: vi.fn(() => true),
      kill: vi.fn(),
    },
    logger: makeLogger("error", "test"),
    idleHours,
  };
  return { deps: deps as never as Parameters<typeof startReapWatchdog>[0], raw: deps };
}

function mockGrowingCpuTime(perTick: number): void {
  let total = 0;
  vi.mocked(getCpuTimeSeconds).mockImplementation(() => {
    total += perTick;
    return total;
  });
}

function tickAll(n: number): void {
  for (let i = 0; i < n; i++) vi.advanceTimersByTime(CHECK_INTERVAL_MS);
}

describe("startReapWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    execFileSyncMock.mockReset();
    vi.mocked(getCpuTimeSeconds).mockReset().mockReturnValue(0);
    vi.mocked(killProcess).mockReset().mockReturnValue(true);
    vi.mocked(readClaudeSessionRegistry).mockReset().mockReturnValue([]);
    vi.mocked(isPidAlive).mockReset().mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["EXECUTING", "WAITING_FOR_INPUT"] as const)("does not reap a CPU-idle session in %s", (state) => {
    execFileSyncMock.mockReturnValue(`${TMUX_SESSION} 4242\n`);
    const { deps, raw } = fakeDeps([fakeSession({ state })]);
    const stop = startReapWatchdog(deps);
    tickAll(HOURS_48_TICKS * 2);
    expect(raw.ptyManager.kill).not.toHaveBeenCalled();
    stop();
  });

  it("accumulates small CPU increments across sweeps", () => {
    execFileSyncMock.mockReturnValue(`${TMUX_SESSION} 4242\n`);
    mockGrowingCpuTime(0.25);
    const { deps, raw } = fakeDeps([fakeSession()], 3);
    const stop = startReapWatchdog(deps);
    tickAll(20);
    expect(raw.ptyManager.kill).not.toHaveBeenCalled();
    stop();
  });

  it("does not schedule any interval when idleHours is 0 or negative", () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const stopA = startReapWatchdog(fakeDeps([], 0).deps);
    const stopB = startReapWatchdog(fakeDeps([], -1).deps);
    expect(setIntervalSpy).not.toHaveBeenCalled();
    stopA();
    stopB();
    setIntervalSpy.mockRestore();
  });

  it("kills a tracked, live bridge tmux session through PtyManager once it's been CPU-idle for the full threshold", () => {
    execFileSyncMock.mockReturnValue(`${TMUX_SESSION} 4242\n`);
    vi.mocked(getCpuTimeSeconds).mockReturnValue(10);
    const { deps, raw } = fakeDeps([fakeSession()]);

    const stop = startReapWatchdog(deps);
    tickAll(HOURS_48_TICKS);

    expect(raw.ptyManager.kill).toHaveBeenCalledWith(JID);
    expect(raw.sessionRepo.setState).toHaveBeenCalledWith(JID, "IDLE", { ptyPid: null, waitingSince: null });
    stop();
  });

  it("never kills a bridge tmux session whose CPU time keeps growing — a genuinely busy background task", () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes("list-panes")) return `${TMUX_SESSION} 4242\n`;
      return "";
    });
    mockGrowingCpuTime(5);
    const { deps, raw } = fakeDeps([fakeSession()]);

    const stop = startReapWatchdog(deps);
    tickAll(HOURS_48_TICKS * 2);

    expect(raw.ptyManager.kill).not.toHaveBeenCalled();
    expect(execFileSyncMock).not.toHaveBeenCalledWith(
      "tmux",
      expect.arrayContaining(["kill-session"]),
      expect.anything(),
    );
    stop();
  });

  it("reaps an idle orphaned bridge session with no repository record", () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes("list-panes")) return `${TMUX_SESSION} 4242\n`;
      return "";
    });
    vi.mocked(getCpuTimeSeconds).mockReturnValue(10);
    const { deps } = fakeDeps([]);

    const stop = startReapWatchdog(deps);
    tickAll(HOURS_48_TICKS);

    expect(execFileSyncMock).toHaveBeenCalledWith("tmux", ["kill-session", "-t", TMUX_SESSION], { stdio: "ignore" });
    stop();
  });

  it("never kills idle external Claude Code processes", () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes("list-panes")) return "";
      return "";
    });
    const entry: ClaudeSessionRegistryEntry = { pid: 5555, sessionId: "desktop-session", cwd: "/tmp/desktop" };
    vi.mocked(readClaudeSessionRegistry).mockReturnValue([entry]);
    vi.mocked(getCpuTimeSeconds).mockReturnValue(3);
    const { deps } = fakeDeps([]);

    const stop = startReapWatchdog(deps);
    tickAll(HOURS_48_TICKS);

    expect(killProcess).not.toHaveBeenCalled();
    stop();
  });

  it("never kills an external Claude Code process that's still burning real CPU", () => {
    execFileSyncMock.mockReturnValue("");
    const entry: ClaudeSessionRegistryEntry = { pid: 5555, sessionId: "desktop-session", cwd: "/tmp/desktop" };
    vi.mocked(readClaudeSessionRegistry).mockReturnValue([entry]);
    mockGrowingCpuTime(4);
    const { deps } = fakeDeps([]);

    const stop = startReapWatchdog(deps);
    tickAll(HOURS_48_TICKS * 2);

    expect(killProcess).not.toHaveBeenCalled();
    stop();
  });

  it("does not double-handle a registry pid that's actually a bridge-owned pane's own engine process", () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes("list-panes")) return `${TMUX_SESSION} 4242\n`;
      return "";
    });
    const entry: ClaudeSessionRegistryEntry = { pid: 4242, sessionId: "reap-resume-id", cwd: "/tmp/project" };
    vi.mocked(readClaudeSessionRegistry).mockReturnValue([entry]);
    vi.mocked(getCpuTimeSeconds).mockReturnValue(10);
    const { deps, raw } = fakeDeps([fakeSession()]);

    const stop = startReapWatchdog(deps);
    tickAll(HOURS_48_TICKS);

    expect(raw.ptyManager.kill).toHaveBeenCalledTimes(1);
    expect(killProcess).not.toHaveBeenCalled();
    stop();
  });
});
