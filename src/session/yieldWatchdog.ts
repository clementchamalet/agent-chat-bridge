import { findExternalResumeProcesses, getCpuTimeSeconds } from "../discovery/externalProcess.js";
import type { SessionRepository } from "../db/sessions.js";
import type { PtyManager } from "../pty/manager.js";
import type { ArbitrationTarget } from "./arbitration.js";
import type { MessageSender } from "../channel/types.js";
import type { Logger } from "../utils/logger.js";

const CHECK_INTERVAL_MS = 30_000;
const ACTIVE_CPU_DELTA_SECONDS = 1;
// A burst of real activity that stops (an accidental click, a brief peek)
// shouldn't interrupt a chat conversation either — require it to
// still be measurably active on the next check too.
const CONSECUTIVE_ACTIVE_CHECKS_REQUIRED = 2;

export interface YieldWatchdogDeps {
  sessionRepo: SessionRepository;
  ptyManager: PtyManager;
  sender: MessageSender;
  logger: Logger;
  presentArbitration: (jid: string, target: ArbitrationTarget, elsewherePids: number[]) => Promise<void>;
}

interface TrackedState {
  /** Summed CPU time (seconds) across matching external pids, as of the last check. */
  lastCpuTime: number;
  /** Consecutive checks in a row where CPU time grew by at least ACTIVE_CPU_DELTA_SECONDS. */
  activeStreak: number;
}

export interface YieldWatchdog {
  stop: () => void;
  /** Pings `jid` once `target` is no longer active elsewhere — see arbitration flow, "leave it on the Mac". */
  watchForFree: (jid: string, target: ArbitrationTarget) => void;
}

export function startYieldWatchdog(deps: YieldWatchdogDeps): YieldWatchdog {
  const tracked = new Map<string, TrackedState>();
  const freeWatches = new Map<string, ArbitrationTarget>();

  const interval = setInterval(() => {
    for (const [jid, target] of freeWatches) {
      const elsewhere = findExternalResumeProcesses(target.engine, target.resumeId, target.tmuxSession);
      if (elsewhere.length > 0) continue;
      freeWatches.delete(jid);
      void deps.sender
        .sendText(jid, `🔓 *${target.title}* is available again. Use /sessions to resume it.`)
        .catch((err) => deps.logger.warn(`could not notify ${jid} that the session is free:`, err));
    }

    for (const session of deps.sessionRepo.listAll()) {
      if (!deps.ptyManager.isAlive(session.jid)) {
        tracked.delete(session.jid);
        continue;
      }

      const resumeId = session.resumeId;
      if (!resumeId) continue; // a brand-new conversation has no id to collide on yet

      const elsewhere = findExternalResumeProcesses(session.engine, resumeId, session.tmuxSession);
      if (elsewhere.length === 0) {
        tracked.delete(session.jid);
        continue;
      }

      const cpuTime = elsewhere.reduce((sum, pid) => sum + (getCpuTimeSeconds(pid) ?? 0), 0);
      const prior = tracked.get(session.jid);
      if (!prior) {
        // First sighting — no baseline to compare against yet, so there's
        // no way to tell "just opened" from "already busy" on this check
        // alone. Record it and decide on the next one.
        tracked.set(session.jid, { lastCpuTime: cpuTime, activeStreak: 0 });
        continue;
      }

      const wasActive = cpuTime - prior.lastCpuTime >= ACTIVE_CPU_DELTA_SECONDS;
      const activeStreak = wasActive ? prior.activeStreak + 1 : 0;

      if (activeStreak < CONSECUTIVE_ACTIVE_CHECKS_REQUIRED) {
        tracked.set(session.jid, { lastCpuTime: cpuTime, activeStreak });
        continue;
      }

      tracked.delete(session.jid);
      deps.logger.warn(
        `${session.jid}'s session ${session.tmuxSession} is actively resumed elsewhere (pid(s): ${elsewhere.join(", ")}) — asking instead of silently yielding`,
      );
      void deps
        .presentArbitration(
          session.jid,
          {
            engine: session.engine,
            resumeId,
            directory: session.workingDir,
            tmuxSession: session.tmuxSession,
            title: session.title ?? session.workingDir,
            live: true,
          },
          elsewhere,
        )
        .catch((err) => deps.logger.warn(`could not present session arbitration to ${session.jid}:`, err));
    }
  }, CHECK_INTERVAL_MS);

  return {
    stop: () => clearInterval(interval),
    watchForFree: (jid, target) => freeWatches.set(jid, target),
  };
}
