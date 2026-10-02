import type { SessionRepository } from "../db/sessions.js";
import type { PtyManager } from "../pty/manager.js";
import type { MessageSender } from "../channel/types.js";
import type { Logger } from "../utils/logger.js";

const CHECK_INTERVAL_MS = 60_000;

export interface WatchdogDeps {
  sessionRepo: SessionRepository;
  ptyManager: PtyManager;
  sender: MessageSender;
  logger: Logger;
  timeoutMinutes: number;
  maxTaskHours: number;
}

export function startWatchdog(deps: WatchdogDeps): () => void {
  if (deps.timeoutMinutes <= 0 && deps.maxTaskHours <= 0) {
    deps.logger.info("session timeouts disabled");
    return () => {};
  }

  const timeoutMs = deps.timeoutMinutes * 60_000;
  const maxTaskMs = deps.maxTaskHours * 3_600_000;

  const interval = setInterval(() => {
    const now = Date.now();
    for (const session of deps.timeoutMinutes > 0 ? deps.sessionRepo.listByState("WAITING_FOR_INPUT") : []) {
      if (!session.waitingSince) continue;
      const elapsed = now - new Date(session.waitingSince).getTime();
      if (!Number.isFinite(elapsed) || elapsed < timeoutMs) continue;

      deps.logger.warn(`auto-lock timeout hit for ${session.jid} after ${Math.round(elapsed / 60_000)}min`);
      deps.ptyManager.kill(session.jid);
      deps.sessionRepo.update(session.jid, { state: "IDLE", ptyPid: null, waitingSince: null });
      void deps.sender
        .sendText(
          session.jid,
          `⏱️ No reply for ${deps.timeoutMinutes} minutes. The session was stopped to free resources. Send a message to start again.`,
        )
        .catch((err) => deps.logger.warn(`could not notify ${session.jid} of timeout:`, err));
    }
    for (const session of deps.maxTaskHours > 0 ? deps.sessionRepo.listByState("EXECUTING") : []) {
      if (!session.executionStartedAt) continue;
      const elapsed = now - new Date(session.executionStartedAt).getTime();
      if (!Number.isFinite(elapsed) || elapsed < maxTaskMs) continue;

      deps.logger.warn(`task duration limit hit for ${session.jid} after ${Math.round(elapsed / 3_600_000)}h`);
      deps.ptyManager.kill(session.jid);
      deps.sessionRepo.update(session.jid, { state: "IDLE", ptyPid: null, waitingSince: null });
      void deps.sender
        .sendText(session.jid, `⏱️ Task stopped after reaching the ${deps.maxTaskHours}-hour limit.`)
        .catch((err) => deps.logger.warn(`could not notify ${session.jid} of task limit:`, err));
    }
  }, CHECK_INTERVAL_MS);

  return () => clearInterval(interval);
}
