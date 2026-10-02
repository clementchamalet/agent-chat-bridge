import { execFileSync } from "node:child_process";
import { getCpuTimeSeconds } from "../discovery/externalProcess.js";
import { isBridgeSessionName } from "../pty/tmux.js";
import type { SessionRepository } from "../db/sessions.js";
import type { PtyManager } from "../pty/manager.js";
import type { Logger } from "../utils/logger.js";

const CHECK_INTERVAL_MS = 30 * 60_000;
const CPU_DELTA_SECONDS = 1;

export interface ReapWatchdogDeps {
  sessionRepo: SessionRepository;
  ptyManager: PtyManager;
  logger: Logger;
  idleHours: number;
}

interface Tracked {
  /** Cumulative CPU time (seconds) as of the last check. */
  lastCpuTime: number;
  /** Last time that value actually grew — the reap clock runs from here, not from "last check". */
  lastActiveAt: number;
}

interface TmuxPane {
  session: string;
  pid: number;
}

/** Every pane across every live tmux session, filtered to ones this bridge could have created — orphaned or currently attached, either way. */
function listBridgeTmuxPanes(): TmuxPane[] {
  let out: string;
  try {
    out = execFileSync("tmux", ["list-panes", "-a", "-F", "#{session_name} #{pane_pid}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return []; // no tmux server running at all — nothing to sweep
  }
  const panes: TmuxPane[] = [];
  for (const line of out.split("\n")) {
    const [session, pidStr] = line.trim().split(" ");
    if (!session || !isBridgeSessionName(session)) continue;
    const pid = Number(pidStr);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    panes.push({ session, pid });
  }
  return panes;
}

export function startReapWatchdog(deps: ReapWatchdogDeps): () => void {
  if (deps.idleHours <= 0) {
    deps.logger.info("idle-session reaper disabled (REAP_IDLE_HOURS <= 0)");
    return () => {};
  }

  const idleThresholdMs = deps.idleHours * 60 * 60_000;
  const tracked = new Map<string, Tracked>();

  /** Updates `key`'s CPU tracking and reports whether it's now crossed the idle threshold. */
  function checkIdle(key: string, cpuTime: number, now: number, updatedAt?: number): boolean {
    const prior = tracked.get(key);
    if (!prior) {
      // First sighting — no baseline to compare against yet, so there's no
      // way to tell "already idle for days" from "just started" on this
      // check alone. Treated as active-as-of-now; decided on a later sweep.
      tracked.set(key, {
        lastCpuTime: cpuTime,
        lastActiveAt: updatedAt !== undefined && Number.isFinite(updatedAt) ? updatedAt : now,
      });
      return false;
    }
    const grew = cpuTime < prior.lastCpuTime || cpuTime - prior.lastCpuTime >= CPU_DELTA_SECONDS;
    const lastActiveAt = grew
      ? now
      : Math.max(
          prior.lastActiveAt,
          updatedAt !== undefined && Number.isFinite(updatedAt) ? updatedAt : prior.lastActiveAt,
        );
    tracked.set(key, { lastCpuTime: grew ? cpuTime : prior.lastCpuTime, lastActiveAt });
    return now - lastActiveAt >= idleThresholdMs;
  }

  function sweep(): void {
    const now = Date.now();
    const seenKeys = new Set<string>();
    const panes = listBridgeTmuxPanes();
    const records = deps.sessionRepo.listAll();

    for (const { session, pid } of panes) {
      const key = `tmux:${session}:${pid}`;
      seenKeys.add(key);
      const record = records.find((s) => s.tmuxSession === session);
      if (record && record.state !== "IDLE") {
        tracked.delete(key);
        continue;
      }
      if (panes.filter((pane) => pane.session === session).length > 1) continue;
      const cpuTime = getCpuTimeSeconds(pid);
      if (cpuTime === null) continue; // pane's process vanished between list and check
      if (!checkIdle(key, cpuTime, now, record ? Date.parse(record.updatedAt) : undefined)) continue;

      tracked.delete(key);
      deps.logger.warn(
        `reap: killing idle tmux session ${session} (pid ${pid}) — no CPU activity for ${deps.idleHours}h+`,
      );
      if (record && deps.ptyManager.isAlive(record.jid)) {
        deps.ptyManager.kill(record.jid);
        deps.sessionRepo.setState(record.jid, "IDLE", { ptyPid: null, waitingSince: null });
      } else {
        try {
          execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
        } catch {
          // Already gone.
        }
      }
    }

    // Forget anything that's disappeared on its own (exited, session
    // closed) since the last sweep — nothing left to reap, and a reused
    // pid later shouldn't inherit a stale baseline.
    for (const key of tracked.keys()) {
      if (!seenKeys.has(key)) tracked.delete(key);
    }
  }

  const interval = setInterval(sweep, CHECK_INTERVAL_MS);
  return () => clearInterval(interval);
}
