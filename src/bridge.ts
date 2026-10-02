import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { isBridgeCommand, isControlCommand, isPassiveCommand, parseCommand, routeCommand } from "./commands/router.js";
import type { SessionRepository } from "./db/sessions.js";
import { findExternalResumeProcesses, killProcess } from "./discovery/externalProcess.js";
import {
  discoverClaudeSessions,
  discoverOpencodeSessions,
  discoverCodexSessions,
  type DiscoveredSession,
} from "./discovery/sessions.js";
import type { Engine } from "./types.js";
import type { PtyManager, ReplyInfo } from "./pty/manager.js";
import { liveSessionName, placeholderSessionName } from "./pty/tmux.js";
import type { ArbitrationTarget } from "./session/arbitration.js";
import type { Picker } from "./session/picker.js";
import type { YieldWatchdog } from "./session/yieldWatchdog.js";
import type { SessionRecord } from "./types.js";
import { startFreshSession } from "./commands/handlers.js";
import { config } from "./config.js";
import { extForMimeType } from "./utils/mime.js";
import { prepareInboxDirectory, pruneExpiredFiles } from "./utils/inbox.js";
import { formatProjectLabel } from "./utils/paths.js";
import type { Logger } from "./utils/logger.js";
import type { IncomingMessage, MessageSender, MessageSource } from "./channel/types.js";
import { formatAgentContent, formatTranscriptReply, formatRunFooter } from "./channel/outbound.js";

export interface BridgeDeps {
  source: MessageSource;
  ptyManager: PtyManager;
  sessionRepo: SessionRepository;
  sender: MessageSender;
  sessionPicker: Picker<DiscoveredSession>;
  filePicker: Picker<string>;
  /** Directory picked from /repo — see cmdRepo/knownRepoDirectories in commands/handlers.ts. */
  repoPicker: Picker<string>;
  logger: Logger;
  watchForFree: YieldWatchdog["watchForFree"];
}

interface QueuedMessage {
  text: string;
  /** Channel message ID for the delivery reaction. */
  key: string;
}

interface PendingArbitration {
  target: ArbitrationTarget;
  elsewherePids: number[];
  initiatedBy: "channel" | "mac";
}

interface RunOutputState {
  startedAt: number;
  finalSent: boolean;
  lastProgress: string | null;
  lastQuestion: string | null;
}

export class Bridge {
  private accepting = true;
  private readonly queues = new Map<string, QueuedMessage[]>();

  private readonly chains = new Map<string, Promise<void>>();

  private readonly arbitrations = new Map<string, PendingArbitration>();

  /** The tmux session a jid's last outgoing PTY-mirrored message belonged to — see sendSessionText/session switching. */
  private readonly lastSentTmuxSession = new Map<string, string>();
  private readonly runs = new Map<string, RunOutputState>();
  private readonly lastCompletedPayload = new Map<string, string>();
  private readonly inboundTimes = new Map<string, number[]>();
  private readonly generations = new Map<string, number>();

  constructor(private readonly deps: BridgeDeps) {
    deps.sender.setFooterProvider?.((jid) => this.footerFor(jid));
  }

  private footerFor(jid: string): string {
    const session = this.deps.sessionRepo.get(jid);
    const run = this.runs.get(jid);
    return formatRunFooter(
      session?.resolvedModel ?? session?.model ?? session?.engine ?? null,
      session?.engine === "claude" ? session.effort : "n/a",
      run ? Date.now() - run.startedAt : null,
    );
  }

  private startRun(jid: string): void {
    this.lastCompletedPayload.delete(jid);
    this.runs.set(jid, { startedAt: Date.now(), finalSent: false, lastProgress: null, lastQuestion: null });
  }

  wire(): void {
    this.deps.source.on("message", (msg) => {
      this.serialize(msg.jid, () => this.handleIncoming(msg));
    });

    this.deps.ptyManager.on("question", (jid, text, truncated, info) => {
      this.serializeAgent(jid, () => this.handleQuestion(jid, text, truncated, info));
    });

    this.deps.ptyManager.on("complete", (jid, text, truncated, info) => {
      this.serializeAgent(jid, () => this.handleComplete(jid, text, truncated, info));
    });

    // A fork resolving to its real id, or /clear moving the process onto a
    // brand-new conversation — see PtyManager's pollClaude.
    this.deps.ptyManager.on("identityChanged", (jid, sessionId) => {
      this.serializeAgent(jid, () => this.handleIdentityChanged(jid, sessionId));
    });

    this.deps.ptyManager.on("catchup", (jid, text, truncated) => {
      this.serializeAgent(jid, () => this.handleCatchup(jid, text, truncated));
    });

    this.deps.ptyManager.on("progress", (jid, text, info) => {
      this.serializeAgent(jid, () => this.handleProgress(jid, text, info));
    });

    this.deps.ptyManager.on("modelResolved", (jid, modelName) => {
      this.serializeAgent(jid, async () => {
        this.deps.sessionRepo.update(jid, { resolvedModel: modelName });
      });
    });

    this.deps.ptyManager.on("exit", (jid, code, signal) => {
      this.serializeAgent(jid, () => this.handleExit(jid, code, signal));
    });

    this.deps.ptyManager.on("error", (jid, err) => {
      this.serializeAgent(jid, () => this.handleSpawnError(jid, err));
    });

    // Must run after every ptyManager.on() listener above is registered —
    // it can itself reattach a survived session (see its own doc), whose
    // very first settle event needs somewhere to land.
    this.reconcileStaleSessions();
  }

  private serialize(jid: string, task: () => Promise<void>): Promise<void> {
    if (!this.accepting) return Promise.resolve();
    const prior = this.chains.get(jid) ?? Promise.resolve();
    const next = prior.then(task).catch((err) => {
      this.deps.logger.child({ session: jid }).error("unhandled message processing error:", err);
    });
    this.chains.set(jid, next);
    void next.then(() => {
      if (this.chains.get(jid) === next) this.chains.delete(jid);
    });
    return next;
  }

  private serializeAgent(jid: string, task: () => Promise<void>): Promise<void> {
    const generation = this.generations.get(jid) ?? 0;
    return this.serialize(jid, async () => {
      if ((this.generations.get(jid) ?? 0) === generation) await task();
    });
  }

  async stop(): Promise<void> {
    this.accepting = false;
    await Promise.all(this.chains.values());
  }

  /** Saves an incoming image outside project directories. */
  private async saveIncomingImage(jid: string, mediaId: string): Promise<string | null> {
    const media = await this.deps.sender.downloadMedia(mediaId);
    if (!media) return null;

    const dir = prepareInboxDirectory(jid);
    pruneExpiredFiles(dir);
    const ext = extForMimeType(media.mimeType) || ".bin";
    const filePath = path.join(dir, `${randomUUID()}${ext}`);
    fs.writeFileSync(filePath, media.buffer, { mode: 0o600, flag: "wx" });
    return filePath;
  }

  private reconcileStaleSessions(): void {
    for (const session of this.deps.sessionRepo.listAll()) {
      const wasBusy = session.state === "EXECUTING" || session.state === "WAITING_FOR_INPUT";
      this.deps.sessionRepo.update(session.jid, { state: "IDLE", ptyPid: null, waitingSince: null });

      if (!wasBusy || !this.deps.ptyManager.isTmuxSessionAlive(session.tmuxSession)) continue;

      try {
        this.deps.ptyManager.start(
          session.jid,
          {
            engine: session.engine,
            model: session.model,
            effort: session.effort,
            cwd: session.workingDir,
            sessionName: session.tmuxSession,
            resumeId: session.started ? (session.resumeId ?? undefined) : undefined,
            sessionId: !session.started ? (session.resumeId ?? undefined) : undefined,
            knownModelName: session.resolvedModel,
          },
          null,
        );
        this.deps.sessionRepo.update(session.jid, { ptyPid: this.deps.ptyManager.getPid(session.jid) });
        this.deps.sessionRepo.setState(session.jid, session.state, {
          waitingSince: session.waitingSince,
          executionStartedAt: session.executionStartedAt,
        });
      } catch (err) {
        this.deps.logger.child({ session: session.jid }).error("failed to reattach survived session:", err);
      }
    }
  }

  private async handleIncoming(msg: IncomingMessage): Promise<void> {
    const { jid, key } = msg;
    let text = msg.text;

    const now = Date.now();
    const recent = (this.inboundTimes.get(jid) ?? []).filter((time) => now - time < 60_000);
    if (recent.length >= config.maxMessagesPerMinute) {
      await this.deps.sender.sendText(jid, "⏳ Message rate limit reached. Try again in one minute.");
      return;
    }
    recent.push(now);
    this.inboundTimes.set(jid, recent);

    if (text.length > 12_000) {
      await this.deps.sender.sendText(jid, "❌ Message exceeds the 12,000 character limit.");
      return;
    }

    if (msg.image) {
      const saved = await this.saveIncomingImage(jid, msg.image.mediaId);
      if (!saved) {
        await this.deps.sender.sendText(jid, "❌ Could not download the image.");
        return;
      }
      text = [msg.image.caption, `[Received image: ${saved}]`].filter(Boolean).join("\n\n");
    }

    const session = this.deps.sessionRepo.getOrCreate(jid);
    this.deps.logger.child({ session: jid }).info(`received ${text.length} characters in ${session.state}`);

    // Process controls remain available during execution and input waits.
    if (isControlCommand(text)) {
      if (parseCommand(text)?.name === "kill") this.resetConversationState(jid);
      await routeCommand(this.deps, jid, session, text);
      return;
    }

    const arbitration = this.arbitrations.get(jid);
    if (arbitration) {
      await this.resolveArbitration(jid, session, arbitration, text);
      return;
    }

    if (isPassiveCommand(text)) {
      if (parseCommand(text)?.name === "file") {
        this.deps.sessionPicker.clear(jid);
        this.deps.repoPicker.clear(jid);
      }
      if (parseCommand(text)?.name === "discard" && (this.queues.get(jid)?.length ?? 0) > 0) {
        this.queues.delete(jid);
        this.deps.ptyManager.cancelPendingInitial(jid);
        await this.deps.sender.sendText(jid, "🗑️ Queued messages discarded.");
        return;
      }
      await routeCommand(this.deps, jid, session, text);
      return;
    }

    if (await this.resolvePickers(jid, session, text)) return;

    if (isBridgeCommand(text)) {
      const name = parseCommand(text)?.name;
      if (name === "sessions") {
        this.deps.filePicker.clear(jid);
        this.deps.repoPicker.clear(jid);
      } else if (name === "repo") {
        this.deps.filePicker.clear(jid);
        this.deps.sessionPicker.clear(jid);
      }
      if (name === "commit" && session.state !== "IDLE") {
        await this.deps.sender.sendText(
          jid,
          "⏳ A task is running. Wait for it to finish or use /stop before committing.",
        );
        return;
      }
      await routeCommand(this.deps, jid, session, text);
      if (name === "new" && this.deps.sessionRepo.get(jid)?.tmuxSession !== session.tmuxSession) {
        this.resetConversationState(jid);
      }
      return;
    }

    if (session.state === "WAITING_FOR_INPUT") {
      // An AskUserQuestion mirrored from Claude's transcript: a digit picks
      // its option, anything else becomes the "Type something" answer.
      if (this.deps.ptyManager.answerAsk?.(jid, text)) {
        await this.deps.sender.react(jid, "✅", key);
        this.deps.sessionRepo.setState(jid, "EXECUTING", { waitingSince: null });
        return;
      }
      const digit = /^\d+$/.test(text.trim()) ? Number(text.trim()) : null;
      const pendingMenu = this.deps.ptyManager.getPendingMenu(jid);
      if (pendingMenu && (digit === null || digit < 1 || digit > pendingMenu.count)) {
        await this.deps.sender.react(jid, "🤔", key);
        await this.deps.sender.sendText(
          jid,
          `This question expects an option number from 1 to ${pendingMenu.count}. Reply with the number.`,
        );
        return;
      }
      await this.deps.sender.react(jid, "⏳", key);
      const sentMenuChoice = digit !== null && this.deps.ptyManager.sendMenuChoice(jid, digit);
      if (!sentMenuChoice) this.deps.ptyManager.send(jid, text);
      await this.deps.sender.react(jid, "✅", key);
      this.deps.sessionRepo.setState(jid, "EXECUTING", { waitingSince: null });
      return;
    }

    if (session.state === "EXECUTING") {
      const queue = this.queues.get(jid) ?? [];
      if (queue.length >= 20) {
        await this.deps.sender.sendText(jid, "⏳ The 20-message queue is full. Wait or use /discard.");
        return;
      }
      queue.push({ text, key });
      this.queues.set(jid, queue);
      await this.deps.sender.react(jid, "📥", key);
      return;
    }

    // session.state === "IDLE"
    await this.deps.sender.react(jid, "⏳", key);
    if (await this.beginExecution(jid, session, text)) await this.deps.sender.react(jid, "✅", key);
  }

  /** Forgets per-conversation delivery state — the queued backlog and the in-flight run — when the chat moves to a different conversation. */
  private resetConversationState(jid: string): void {
    this.generations.set(jid, (this.generations.get(jid) ?? 0) + 1);
    this.queues.delete(jid);
    this.runs.delete(jid);
    this.arbitrations.delete(jid);
    this.lastCompletedPayload.delete(jid);
    this.deps.sessionPicker.clear(jid);
    this.deps.filePicker.clear(jid);
    this.deps.repoPicker.clear(jid);
  }

  private async resolvePickers(jid: string, session: SessionRecord, text: string): Promise<boolean> {
    const hashPick = /^#(\d+)$/.exec(text.trim());
    if (hashPick) {
      const pick = this.deps.sessionPicker.peekAt(jid, Number(hashPick[1]));
      if (pick) {
        await this.switchToSession(jid, session, pick);
        return true;
      }
    }

    if (this.deps.sessionPicker.has(jid)) {
      const pick = this.deps.sessionPicker.resolve(jid, text);
      if (pick === "more") {
        await this.sendPickerPage(jid, this.deps.sessionPicker);
        return true;
      }
      if (pick) {
        await this.switchToSession(jid, session, pick);
        return true;
      }
    } else if (this.deps.filePicker.has(jid)) {
      const pick = this.deps.filePicker.resolve(jid, text);
      if (pick === "more") {
        await this.sendPickerPage(jid, this.deps.filePicker);
        return true;
      }
      if (pick) {
        await this.deps.sender.sendDocument(jid, pick);
        return true;
      }
    } else if (this.deps.repoPicker.has(jid)) {
      const pick = this.deps.repoPicker.resolve(jid, text);
      if (pick === "more") {
        await this.sendPickerPage(jid, this.deps.repoPicker);
        return true;
      }
      if (pick) {
        // Same action /new takes with no engine/model/effort given —
        // /repo only ever changes *where*, keeping the current session's
        // engine/model/effort exactly as they were.
        await startFreshSession(this.deps, jid, session.engine, session.model, session.effort, pick);
        if (this.deps.sessionRepo.get(jid)?.tmuxSession !== session.tmuxSession) this.resetConversationState(jid);
        return true;
      }
    }
    return false;
  }

  private hasCapacity(jid: string): boolean {
    return (
      this.deps.sessionRepo
        .listAll()
        .filter((record) => record.jid !== jid && (this.deps.ptyManager.isAlive(record.jid) || record.state !== "IDLE"))
        .length < config.maxActiveSessions
    );
  }

  private async beginExecution(jid: string, session: SessionRecord, text: string): Promise<boolean> {
    if (!this.deps.ptyManager.isAlive(jid)) {
      if (!this.hasCapacity(jid)) {
        this.deps.sessionRepo.setState(jid, "IDLE", { ptyPid: null, waitingSince: null });
        await this.deps.sender.sendText(
          jid,
          `⏳ ${config.maxActiveSessions} sessions are already active. Stop one before starting another.`,
        );
        return false;
      }
    }
    this.startRun(jid);
    this.deps.logger
      .child({ session: jid })
      .info(
        `${this.deps.ptyManager.isAlive(jid) ? "sending to" : "starting"} ${session.engine} in ${session.workingDir} (${session.tmuxSession})`,
      );
    if (this.deps.ptyManager.isAlive(jid)) {
      this.deps.ptyManager.send(jid, text);
    } else {
      try {
        this.deps.ptyManager.start(
          jid,
          {
            engine: session.engine,
            model: session.model,
            effort: session.effort,
            cwd: session.workingDir,
            sessionName: session.tmuxSession,
            resumeId: session.started ? (session.resumeId ?? undefined) : undefined,
            sessionId: !session.started ? (session.resumeId ?? undefined) : undefined,
            knownModelName: session.resolvedModel,
          },
          text,
        );
      } catch (err) {
        this.runs.delete(jid);
        this.deps.sessionRepo.setState(jid, "IDLE", { ptyPid: null, waitingSince: null });
        await this.deps.sender.sendText(
          jid,
          `❌ Could not start ${session.engine}: ${err instanceof Error ? err.message : String(err)}. Check that the CLI is installed and available on PATH.`,
        );
        return false;
      }
      this.deps.sessionRepo.update(jid, { ptyPid: this.deps.ptyManager.getPid(jid), started: true });

      // Resolve OpenCode and Codex IDs after startup without blocking incoming messages.
      if (session.engine !== "claude" && !session.resumeId) {
        void this.resolveNewIdentity(jid, session.engine, session.workingDir, session.tmuxSession, Date.now()).catch(
          (err) => this.deps.logger.warn(`could not resolve ${session.engine} identity for ${jid}:`, err),
        );
      }
    }

    this.deps.sessionRepo.setState(jid, "EXECUTING");
    return true;
  }

  private async resolveNewIdentity(
    jid: string,
    engine: Engine,
    cwd: string,
    placeholderTmuxSession: string,
    since: number,
  ): Promise<void> {
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (this.deps.sessionRepo.get(jid)?.tmuxSession !== placeholderTmuxSession) return;

      const candidates =
        engine === "opencode"
          ? discoverOpencodeSessions()
          : engine === "codex"
            ? discoverCodexSessions()
            : discoverClaudeSessions();
      const ownedIds = new Set(
        this.deps.sessionRepo
          .listAll()
          .filter((s) => s.jid !== jid && s.engine === engine && s.resumeId)
          .map((s) => s.resumeId),
      );
      const match = candidates.find((s) => s.directory === cwd && s.updatedAt >= since && !ownedIds.has(s.resumeId));
      if (!match) continue;

      await this.serialize(jid, async () => {
        if (this.deps.sessionRepo.get(jid)?.tmuxSession !== placeholderTmuxSession) return;
        const liveName = liveSessionName(engine, match.resumeId);
        if (this.deps.ptyManager.renameSession(jid, liveName)) {
          this.deps.sessionRepo.update(jid, { tmuxSession: liveName, resumeId: match.resumeId, started: true });
        }
      });
      return;
    }
    this.deps.logger.child({ session: jid }).warn(`could not resolve ${engine} session id in ${cwd}`);
  }

  private async sendPickerPage<T>(jid: string, picker: Picker<T>): Promise<void> {
    const text = picker.renderPage(jid);
    if (text) await this.deps.sender.sendText(jid, text);
  }

  private async switchToSession(jid: string, session: SessionRecord, target: DiscoveredSession): Promise<void> {
    let isDir = false;
    try {
      isDir = fs.statSync(target.directory).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      await this.deps.sender.sendText(
        jid,
        `❌ Directory not found: \`${target.directory}\` (the session may have been removed).`,
      );
      return;
    }

    const owner = this.deps.sessionRepo
      .listAll()
      .find(
        (other) =>
          other.jid !== jid &&
          other.engine === target.engine &&
          other.resumeId === target.resumeId &&
          other.tmuxSession === target.tmuxSession &&
          (target.live || this.deps.ptyManager.isAlive(other.jid)),
      );
    if (owner) {
      await this.deps.sender.sendText(
        jid,
        "That session is already attached to another chat. Stop it there before selecting it here.",
      );
      return;
    }

    const elsewhere = findExternalResumeProcesses(target.engine, target.resumeId, target.tmuxSession);
    if (elsewhere.length > 0) {
      await this.presentArbitration(jid, target, elsewhere, "channel");
      return;
    }

    await this.attachToTarget(jid, session, target, false);
  }

  async presentArbitration(
    jid: string,
    target: ArbitrationTarget,
    elsewherePids: number[],
    initiatedBy: "channel" | "mac",
  ): Promise<void> {
    if (initiatedBy === "mac") {
      return this.serialize(jid, () => this.presentArbitrationCore(jid, target, elsewherePids, initiatedBy));
    }
    return this.presentArbitrationCore(jid, target, elsewherePids, initiatedBy);
  }

  private async presentArbitrationCore(
    jid: string,
    target: ArbitrationTarget,
    elsewherePids: number[],
    initiatedBy: "channel" | "mac",
  ): Promise<void> {
    this.arbitrations.set(jid, { target, elsewherePids, initiatedBy });

    const where = initiatedBy === "channel" ? "on this Mac" : "also open on this Mac";
    await this.deps.sender.sendText(
      jid,
      [
        `⚠️ *${target.title}* is ${where} (desktop app or terminal).`,
        ``,
        `1. Take control here and close the other process`,
        `2. Leave it on the Mac and notify me when it is free`,
        `3. Fork the conversation and work in parallel`,
        ``,
        `Reply 1, 2, or 3.`,
      ].join("\n"),
    );
  }

  private async resolveArbitration(
    jid: string,
    session: SessionRecord,
    arbitration: PendingArbitration,
    text: string,
  ): Promise<void> {
    const choice = text.trim();
    if (choice !== "1" && choice !== "2" && choice !== "3") {
      await this.deps.sender.sendText(jid, "Reply 1, 2, or 3.");
      return; // stays pending
    }
    this.arbitrations.delete(jid);
    const { target, initiatedBy } = arbitration;

    if (choice === "1") {
      // Re-check process IDs because macOS may recycle them during arbitration.
      const freshPids = findExternalResumeProcesses(target.engine, target.resumeId, target.tmuxSession);
      for (const pid of freshPids) killProcess(pid);
      await this.deps.sender.sendText(jid, `✅ Closed ${freshPids.length} external process(es) using this session.`);
      if (initiatedBy === "channel") {
        await this.attachToTarget(jid, session, target, false);
      }
      // Mac-initiated: the chat session is already active.
      return;
    }

    if (choice === "2") {
      // Leave control with the local process.
      if (initiatedBy === "channel") {
        this.deps.watchForFree(jid, target);
        await this.deps.sender.sendText(jid, "The Mac keeps control. I will notify you when the session is free.");
      } else {
        this.resetConversationState(jid);
        this.deps.ptyManager.kill(jid);
        this.deps.sessionRepo.update(jid, { state: "IDLE", ptyPid: null, waitingSince: null });
        await this.deps.sender.sendText(jid, "The Mac keeps control.");
      }
      return;
    }

    // Fork without changing the other process.
    await this.attachToTarget(jid, session, target, true);
  }

  private async attachToTarget(
    jid: string,
    session: SessionRecord,
    target: ArbitrationTarget | DiscoveredSession,
    fork: boolean,
  ): Promise<void> {
    if (!this.hasCapacity(jid)) {
      await this.deps.sender.sendText(jid, "⏳ Session limit reached. Stop another session before switching.");
      return;
    }
    if (this.deps.ptyManager.isAlive(jid)) await this.deps.ptyManager.detach(jid);
    this.resetConversationState(jid);

    const tmuxSession = fork ? placeholderSessionName(target.engine, jid) : target.tmuxSession;
    const live = "live" in target ? target.live : false;

    this.deps.sessionRepo.update(jid, {
      engine: target.engine,
      model: target.engine === session.engine ? session.model : null,
      effort: target.engine === session.engine ? session.effort : null,
      workingDir: target.directory,
      tmuxSession,
      resumeId: fork ? null : target.resumeId,
      title: fork ? `${target.title} (fork)` : target.title,
      started: !fork, // a fork's new id isn't known/spawned-under yet
      ptyPid: null,
      state: "EXECUTING",
      waitingSince: null,
      // Model labels belong to the selected conversation.
      resolvedModel: null,
    });

    const spawnedAt = Date.now();
    try {
      this.deps.ptyManager.start(
        jid,
        {
          engine: target.engine,
          model: target.engine === session.engine ? session.model : null,
          effort: target.engine === session.engine ? session.effort : null,
          cwd: target.directory,
          sessionName: tmuxSession,
          resumeId: fork || !live ? target.resumeId : undefined,
          fork,
        },
        null,
      );
    } catch (err) {
      await this.handleSpawnError(jid, err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.deps.sessionRepo.update(jid, { ptyPid: this.deps.ptyManager.getPid(jid) });

    // Claude forks report their ID through the registry; other engines require discovery.
    if (fork && target.engine !== "claude") {
      void this.resolveNewIdentity(jid, target.engine, target.directory, tmuxSession, spawnedAt).catch((err) =>
        this.deps.logger.warn(`could not resolve fork identity for ${jid}:`, err),
      );
    }

    const verb = fork ? "Forked" : live ? "Switched to" : "Resuming";
    await this.deps.sender.sendText(jid, `🔀 ${verb} *${target.title}*…`);
  }

  private async sendSessionText(
    jid: string,
    session: SessionRecord,
    text: string,
    truncated = false,
    kind: "progress" | "question" | "final" | "catchup" = "final",
    info?: ReplyInfo,
  ): Promise<void> {
    const existingRun = this.runs.get(jid);
    if (kind === "final" && existingRun?.finalSent) return;
    const previous = this.lastSentTmuxSession.get(jid);
    this.lastSentTmuxSession.set(jid, session.tmuxSession);
    const changed = previous !== undefined && previous !== session.tmuxSession;
    const prefix = changed
      ? `▸ ${formatProjectLabel(session.workingDir)}${session.title ? ` · ${session.title}` : ""}\n`
      : "";
    const suffix = truncated ? "\n\n⚠️ The reply may be truncated by the terminal viewport." : "";
    const body =
      (info?.clean ? formatTranscriptReply(text, info.toolCount) : formatAgentContent(text)) ||
      "(empty screen; use /screen to inspect the raw terminal)";
    const formatted = `${prefix}${body}${suffix}`;

    if (kind === "final" && !existingRun && this.lastCompletedPayload.get(jid) === formatted) return;

    const run = existingRun ?? { startedAt: Date.now(), finalSent: false, lastProgress: null, lastQuestion: null };
    this.runs.set(jid, run);

    if (kind === "progress") {
      if (run.lastProgress === formatted) return;
    } else if (kind === "question") {
      if (run.lastQuestion === formatted) return;
    }

    await this.deps.sender.sendText(jid, formatted, { agentReply: true });
    if (kind === "final") {
      run.finalSent = true;
      this.lastCompletedPayload.set(jid, formatted);
    } else if (kind === "progress") run.lastProgress = formatted;
    else if (kind === "question") run.lastQuestion = formatted;
  }

  private async handleCatchup(jid: string, frameText: string, truncated: boolean): Promise<void> {
    const session = this.deps.sessionRepo.get(jid);
    if (!session) return;
    await this.sendSessionText(jid, session, frameText, truncated, "catchup");
    this.startRun(jid);
  }

  private async handleQuestion(jid: string, frameText: string, truncated: boolean, info?: ReplyInfo): Promise<void> {
    const session = this.deps.sessionRepo.get(jid);
    if (!session) return;

    this.deps.sessionRepo.setState(jid, "WAITING_FOR_INPUT", {
      waitingSince:
        session.state === "WAITING_FOR_INPUT" && session.waitingSince ? session.waitingSince : new Date().toISOString(),
    });
    this.deps.logger.child({ session: jid }).info("question → WAITING_FOR_INPUT");

    await this.sendSessionText(jid, session, frameText, truncated, "question", info);
  }

  /** Opt-in (see /verbose) — a still-in-progress turn produced new content. Silently dropped when verbose is off. */
  private async handleProgress(jid: string, text: string, info?: ReplyInfo): Promise<void> {
    const session = this.deps.sessionRepo.get(jid);
    if (!session?.verbose) return;
    await this.sendSessionText(jid, session, text, false, "progress", info);
  }

  private async handleIdentityChanged(jid: string, sessionId: string): Promise<void> {
    const session = this.deps.sessionRepo.get(jid);
    if (session?.engine !== "claude" || session.resumeId === sessionId) return;
    const liveName = liveSessionName("claude", sessionId);
    const renamed = this.deps.ptyManager.renameSession(jid, liveName);
    this.deps.sessionRepo.update(jid, {
      resumeId: sessionId,
      started: true,
      ...(renamed ? { tmuxSession: liveName } : {}),
    });
    this.deps.logger
      .child({ session: jid })
      .info(`conversation id → ${sessionId}${renamed ? ` (tmux ${liveName})` : ""}`);
  }

  private async handleComplete(jid: string, frameText: string, truncated: boolean, info?: ReplyInfo): Promise<void> {
    const session = this.deps.sessionRepo.get(jid);
    if (!session) return;

    this.deps.logger.child({ session: jid }).info("turn complete");
    if (session.engine !== "claude" && !session.resumeId) {
      const since = this.runs.get(jid)?.startedAt ?? Date.now();
      void this.resolveNewIdentity(jid, session.engine, session.workingDir, session.tmuxSession, since).catch((err) =>
        this.deps.logger.warn(`could not resolve ${session.engine} identity for ${jid}:`, err),
      );
    }
    let deliveryError: unknown;
    try {
      await this.sendSessionText(jid, session, frameText, truncated, "final", info);
    } catch (err) {
      deliveryError = err;
    }

    const queue = this.queues.get(jid);
    const next = queue?.shift();
    if (next) {
      if (await this.beginExecution(jid, session, next.text)) await this.deps.sender.react(jid, "✅", next.key);
      if (deliveryError) throw deliveryError;
      return;
    }

    this.deps.sessionRepo.setState(jid, "IDLE", { waitingSince: null });
    this.runs.delete(jid);
    if (deliveryError) throw deliveryError;
  }

  private async handleExit(jid: string, code: number, signal?: number): Promise<void> {
    this.deps.logger.child({ session: jid }).info(`engine exited (code=${code}${signal ? `, signal=${signal}` : ""})`);
    this.queues.delete(jid); // nothing left to drain into
    this.runs.delete(jid);
    const previous = this.deps.sessionRepo.get(jid);
    this.deps.sessionRepo.update(jid, { state: "IDLE", ptyPid: null, waitingSince: null });

    // A user-initiated /kill already ended the pty and messaged the user —
    // don't pile on with a duplicate "session ended" notice.
    if (previous?.state === "IDLE" && previous.ptyPid === null) return;

    await this.deps.sender.sendText(
      jid,
      `⚠️ The process exited (code=${code}${signal ? `, signal=${signal}` : ""}). Send a message to restart.`,
    );
  }

  private async handleSpawnError(jid: string, err: Error): Promise<void> {
    this.queues.delete(jid);
    this.runs.delete(jid);
    this.deps.sessionRepo.update(jid, { state: "IDLE", ptyPid: null, waitingSince: null });
    await this.deps.sender.sendText(
      jid,
      `❌ Startup failed: ${err.message}\nCheck that tmux and the selected CLI are installed and on PATH.`,
    );
  }
}
