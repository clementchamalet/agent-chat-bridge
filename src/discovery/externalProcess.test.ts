import { execFileSync } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as ptySpawn, type IPty } from "node-pty";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findExternalResumeProcesses, getCpuTimeSeconds, killProcess } from "./externalProcess.js";

const RESUME_ID = "test-resume-id-b4f21a";

function spawnMarked(extraArg: string): ChildProcess {
  return spawn("node", ["-e", "setInterval(() => {}, 1000)", "--", extraArg], { stdio: "ignore" });
}

function waitForExit(child: ChildProcess, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("process did not exit in time")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function killTmux(name: string): void {
  try {
    execFileSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" });
  } catch {
    // already gone
  }
}

describe("findExternalResumeProcesses / killProcess — against real processes", () => {
  let spawned: ChildProcess[] = [];

  it.each([0, 1, -1, -100, NaN, Infinity, process.pid])("refuses unsafe termination targets (%s)", (pid) => {
    expect(killProcess(pid)).toBe(false);
  });

  it("does not treat a session ID as a process-matching regular expression", () => {
    expect(findExternalResumeProcesses("codex", "bridge-regex-id-.*", "wa-codex-none")).toEqual([]);
  });

  afterEach(async () => {
    for (const child of spawned) {
      if (child.pid && !child.killed) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    spawned = [];
  });

  it("finds a real external process whose command line contains the resume id", async () => {
    const child = spawnMarked(RESUME_ID);
    spawned.push(child);
    await new Promise((r) => setTimeout(r, 300));

    const pids = findExternalResumeProcesses("claude", RESUME_ID, "wa-claude-unrelated-session");

    expect(pids).toContain(child.pid);
  });

  it("returns an empty list when nothing matches", () => {
    expect(findExternalResumeProcesses("claude", "no-such-id-anywhere-xyz789", "wa-claude-none")).toEqual([]);
  });

  it("killProcess actually terminates the given pid", async () => {
    const child = spawnMarked(RESUME_ID);
    spawned.push(child);
    await new Promise((r) => setTimeout(r, 300));

    const killed = killProcess(child.pid!);
    expect(killed).toBe(true);

    await waitForExit(child);
  });

  it("killProcess returns false for a pid that doesn't exist", () => {
    expect(killProcess(999_999)).toBe(false);
  });

  describe("excluding the bridge's own process", () => {
    const SESSION = "wa-claude-external-process-test-own";

    afterEach(() => killTmux(SESSION));

    it("excludes the process actually running inside the bridge's own tmux session", async () => {
      execFileSync("tmux", [
        "-u",
        "new-session",
        "-d",
        "-s",
        SESSION,
        "-x",
        "80",
        "-y",
        "24",
        "--",
        "node",
        "-e",
        `setInterval(() => {}, 1000)`,
        "--",
        `--resume=${RESUME_ID}`,
      ]);
      await new Promise((r) => setTimeout(r, 300));

      const pids = findExternalResumeProcesses("claude", RESUME_ID, SESSION);
      expect(pids).toEqual([]);
    });

    it("still finds a genuinely external process sharing the same resume id while excluding the bridge's own", async () => {
      execFileSync("tmux", [
        "-u",
        "new-session",
        "-d",
        "-s",
        SESSION,
        "-x",
        "80",
        "-y",
        "24",
        "--",
        "node",
        "-e",
        `setInterval(() => {}, 1000)`,
        "--",
        `--resume=${RESUME_ID}`,
      ]);
      const external = spawnMarked(RESUME_ID);
      spawned.push(external);
      await new Promise((r) => setTimeout(r, 300));

      const pids = findExternalResumeProcesses("claude", RESUME_ID, SESSION);
      expect(pids).toEqual([external.pid]);
    });

    it("excludes the bridge's own `tmux attach-session` client, not just the engine process inside the pane", async () => {
      const sessionWithId = `wa-claude-${RESUME_ID}`;
      execFileSync("tmux", [
        "-u",
        "new-session",
        "-d",
        "-s",
        sessionWithId,
        "-x",
        "80",
        "-y",
        "24",
        "--",
        "node",
        "-e",
        `setInterval(() => {}, 1000)`,
      ]);
      let attachClient: IPty | null = ptySpawn("tmux", ["-u", "attach-session", "-t", sessionWithId], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
      });
      await new Promise((r) => setTimeout(r, 300));

      try {
        const pids = findExternalResumeProcesses("claude", RESUME_ID, sessionWithId);
        expect(pids).toEqual([]);
      } finally {
        attachClient?.kill();
        attachClient = null;
        killTmux(sessionWithId);
      }
    });

    it("excludes the engine process when a shell sits between it and the pane", async () => {
      execFileSync("tmux", [
        "-u",
        "new-session",
        "-d",
        "-s",
        SESSION,
        "-x",
        "80",
        "-y",
        "24",
        "--",
        "sh",
        "-c",
        `echo starting; node -e 'setInterval(() => {}, 1000)' -- --resume=${RESUME_ID}`,
      ]);
      await new Promise((r) => setTimeout(r, 300));

      const pids = findExternalResumeProcesses("claude", RESUME_ID, SESSION);
      expect(pids).toEqual([]);
    });
  });

  describe("Claude Code session registry", () => {
    let registryDir: string;
    let originalHome: string | undefined;

    beforeEach(() => {
      registryDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-home-test-"));
      fs.mkdirSync(path.join(registryDir, ".claude", "sessions"), { recursive: true });
      originalHome = process.env.HOME;
      process.env.HOME = registryDir;
    });

    afterEach(() => {
      process.env.HOME = originalHome;
      fs.rmSync(registryDir, { recursive: true, force: true });
    });

    it("finds a process the registry knows about even though it was never launched with --resume", async () => {
      const child = spawn("node", ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      spawned.push(child);
      await new Promise((r) => setTimeout(r, 200));

      fs.writeFileSync(
        path.join(registryDir, ".claude", "sessions", `${child.pid}.json`),
        JSON.stringify({ pid: child.pid, sessionId: RESUME_ID, cwd: "/Users/example/project" }),
      );

      const pids = findExternalResumeProcesses("claude", RESUME_ID, "wa-claude-unrelated-session");
      expect(pids).toContain(child.pid);
    });

    it("ignores a registry entry for a pid that's no longer alive", async () => {
      fs.writeFileSync(
        path.join(registryDir, ".claude", "sessions", "999999.json"),
        JSON.stringify({ pid: 999_999, sessionId: RESUME_ID, cwd: "/Users/example/project" }),
      );

      expect(findExternalResumeProcesses("claude", RESUME_ID, "wa-claude-unrelated-session")).toEqual([]);
    });

    it("never consults the registry for opencode — falls back to pgrep-only behavior", async () => {
      const child = spawn("node", ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      spawned.push(child);
      await new Promise((r) => setTimeout(r, 200));

      fs.writeFileSync(
        path.join(registryDir, ".claude", "sessions", `${child.pid}.json`),
        JSON.stringify({ pid: child.pid, sessionId: RESUME_ID, cwd: "/Users/example/project" }),
      );

      expect(findExternalResumeProcesses("opencode", RESUME_ID, "wa-opencode-unrelated-session")).toEqual([]);
    });

    it("degrades cleanly to pgrep-only when the registry directory doesn't exist", async () => {
      fs.rmSync(path.join(registryDir, ".claude"), { recursive: true, force: true });

      const child = spawnMarked(RESUME_ID);
      spawned.push(child);
      await new Promise((r) => setTimeout(r, 300));

      expect(findExternalResumeProcesses("claude", RESUME_ID, "wa-claude-unrelated-session")).toContain(child.pid);
    });
  });
});

describe("getCpuTimeSeconds", () => {
  it("returns a growing number for a genuinely busy process", async () => {
    const child = spawn("node", ["-e", "while (true) {}"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 200));
      const first = getCpuTimeSeconds(child.pid!);
      await new Promise((r) => setTimeout(r, 500));
      const second = getCpuTimeSeconds(child.pid!);

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(second!).toBeGreaterThan(first!);
    } finally {
      if (child.pid) process.kill(child.pid, "SIGKILL");
    }
  });

  it("returns null for a pid that doesn't exist", () => {
    expect(getCpuTimeSeconds(999_999)).toBeNull();
  });
});
