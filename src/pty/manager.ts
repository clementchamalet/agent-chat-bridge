import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { spawn as ptySpawn, type IPty } from "node-pty";
import { config } from "../config.js";
import type { Engine } from "../types.js";
import type { Logger } from "../utils/logger.js";
import { buildSpawnArgs } from "./engines.js";
import { CodexObserver } from "./codexObserver.js";
import { TerminalScreen } from "./terminalScreen.js";
import {
  classifyFrame,
  frameHasMenu,
  isReadyForInput,
  parseMenu,
  trustDialogDownPresses,
  type MenuOptions,
} from "./promptDetector.js";
import {
  extractEffort,
  extractModelName,
  extractModelNameCodex,
  extractReply,
  summarizeFrame,
} from "./frameSummary.js";
import {
  ClaudeTurn,
  TranscriptTail,
  findClaudeTranscript,
  formatAsk,
  isAssistantActivity,
  isUserPrompt,
  latestTurnStartOffset,
  prettyModelName,
  readClaudeRegistryForPid,
  type ClaudeRegistryStatus,
} from "./claudeObserver.js";

export interface StartOptions {
  engine: Engine;
  model: string | null;
  /** Claude Code effort; ignored by the other engines. */
  effort?: string | null;
  cwd: string;
  /** The tmux session to create-or-attach — see src/pty/tmux.ts for naming. */
  sessionName: string;
  /** Resume a conversation when its tmux session is absent. */
  resumeId?: string;
  /** Explicit ID for a new Claude conversation; mutually exclusive with resumeId. */
  sessionId?: string;
  /** Fork the conversation identified by resumeId. */
  fork?: boolean;
  knownModelName?: string | null;
}

const PTY_COLS = 120;
// Must match the TerminalScreen viewport height below — that's what makes
// its scroll-on-overflow behavior agree with what the spawned app assumes
// about its own terminal size.
const PTY_ROWS = 40;

/** Maximum boot observation window before normal input detection takes over. */
const BOOT_MAX_WAIT_MS = 20_000;

const BOOT_MIN_WAIT_MS = 2_000;

const SUBMIT_DELAY_MS = 80;

const PASTE_SUBMIT_DELAY_MS = 250;

/** How often a Claude Code session's registry status and transcript are polled — see ClaudeTracking. */
const CLAUDE_POLL_MS = 500;

const CLAUDE_SETTLE_MS = 1_000;

const CLAUDE_NO_BUSY_FALLBACK_MS = 3_000;

/** While status is "waiting" but the transcript shows no AskUserQuestion, fall back to mirroring the screen after this long. */
const CLAUDE_WAITING_SCREEN_FALLBACK_MS = 2_500;

function tmuxPanePid(sessionName: string): number | null {
  try {
    const out = execFileSync("tmux", ["list-panes", "-t", sessionName, "-F", "#{pane_pid}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const pid = Number(out.split("\n")[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function tmuxSessionExists(name: string): boolean {
  try {
    execFileSync("tmux", ["-u", "has-session", "-t", name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function utf8Env(): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
  };
}

interface ClaudeTracking {
  cwd: string;
  /** The pane's own process — Claude Code itself, whose registry file is `<pid>.json`. Resolved lazily. */
  panePid: number | null;
  /** Conversation id as the registry reports it — authoritative (a fork or /clear changes it). Seeded from the spawn flags. */
  sessionId: string | null;
  /** A brand-new --session-id conversation: its transcript is created by this very process, so it's read from byte 0. */
  freshFile: boolean;
  /** A fork: its new id is only learned from the registry, and must be reported (identityChanged) the first time it's seen. */
  expectNewIdentity: boolean;
  /** Attached with no prompt to deliver (a /sessions pick, a restart reattach): the latest turn is re-read from the transcript and reported. */
  reconstruct: boolean;
  tail: TranscriptTail | null;
  lastTranscriptLookupAt: number;
  status: ClaudeRegistryStatus | null;
  statusSince: number;
  registrySeen: boolean;
  lastGrowthAt: number;
  turn: ClaudeTurn | null;
  /** Key of the question already delivered for the current wait. */
  askReported: string | null;
  askIndex: number;
  lastProgressAt: number;
  /** When the bridge last typed into the pane — a registry status older than this can't end the turn it started. */
  submittedAt: number;
  /** Last menu frame already surfaced as a question, so an unchanged menu isn't re-sent on every tick. */
  lastMenuFrame: string | null;
  lastTrustAnswerAt: number;
  timer: NodeJS.Timeout | null;
}

interface PtySessionHandle {
  jid: string;
  /** Claude Code transcript tracking. */
  claude: ClaudeTracking | null;
  codex: CodexObserver | null;
  sessionName: string;
  /** Engine-specific terminal interpretation. */
  engine: Engine;
  pty: IPty;
  frame: TerminalScreen;
  /** "booting": waiting for the REPL's first paint before we type the queued prompt. */
  phase: "booting" | "running";
  pendingInitial: string | null;
  idleTimer: NodeJS.Timeout | null;
  progressTimer: NodeJS.Timeout | null;
  /** Render captured at the previous boot-phase idle check, to detect a truly settled screen. */
  lastBootFrame: string | null;
  bootStartedAt: number;
  /** Last frame text we actually emitted a question/complete event for, to avoid re-notifying on unchanged output. */
  lastEmittedFrame: string | null;
  /** Display model observed in the agent's terminal. */
  modelName: string | null;
  /** Last observed effort level; some terminal frames omit it. */
  lastKnownEffort: string | null;
  /** Extracted body from the previous running-phase idle check, to require the screen to have truly settled before emitting. */
  pendingSteadyBody: string | null;
  /** Text already sent during the current turn. */
  lastReportedBody: string | null;
  pendingMenu: MenuOptions | null;
  /** Suppress exit notifications during an intentional detach. */
  detaching: boolean;
  submitUntil: number;
  reportBeforeDelivering: boolean;
}

/** Metadata for replies observed through a transcript or terminal. */
export interface ReplyInfo {
  clean: boolean;
  toolCount: number;
}

interface PtyManagerEvents {
  /** True when the terminal viewport may have lost the reply's beginning. */
  question: [jid: string, text: string, truncated: boolean, info?: ReplyInfo];
  complete: [jid: string, text: string, truncated: boolean, info?: ReplyInfo];
  catchup: [jid: string, text: string, truncated: boolean];
  /** A still-in-progress turn produced new content (e.g. another tool call finished) — opt-in, see /verbose. */
  progress: [jid: string, text: string, info?: ReplyInfo];
  /** A fork or reset changed the Claude conversation ID. */
  identityChanged: [jid: string, sessionId: string];
  /** The display model was read from the terminal. */
  modelResolved: [jid: string, modelName: string];
  exit: [jid: string, code: number, signal?: number];
  error: [jid: string, err: Error];
}

export declare interface PtyManager {
  on<E extends keyof PtyManagerEvents>(event: E, listener: (...args: PtyManagerEvents[E]) => void): this;
  emit<E extends keyof PtyManagerEvents>(event: E, ...args: PtyManagerEvents[E]): boolean;
}

/** The longest suffix of `previous` that's also a prefix of `body`, at least `minLen` long — 0 if there's no such overlap. */
function longestOverlap(previous: string, body: string, minLen = 20): number {
  const max = Math.min(previous.length, body.length);
  for (let len = max; len >= minLen; len--) {
    if (previous.slice(previous.length - len) === body.slice(0, len)) return len;
  }
  return 0;
}

export function computeProgressIncrement(previous: string, body: string): string {
  if (body.startsWith(previous)) return body.slice(previous.length).trim();
  const overlap = longestOverlap(previous, body);
  return (overlap > 0 ? body.slice(overlap) : body).trim();
}

export class PtyManager extends EventEmitter {
  private sessions = new Map<string, PtySessionHandle>();

  constructor(
    private readonly logger: Logger,
    private readonly idleMs: number = config.promptIdleMs,
    private readonly progressCheckMs: number = config.progressCheckMs,
    /** Whether mid-turn progress pings are wanted for this chat (/verbose) — narration is only marked as reported when it's actually sent. */
    private readonly isVerbose: (jid: string) => boolean = () => true,
  ) {
    super();
  }

  isAlive(jid: string): boolean {
    return this.sessions.has(jid);
  }

  isTmuxSessionAlive(sessionName: string): boolean {
    return tmuxSessionExists(sessionName);
  }

  getPid(jid: string): number | null {
    return this.sessions.get(jid)?.pty.pid ?? null;
  }

  start(jid: string, opts: StartOptions, initialPrompt: string | null): void {
    if (this.sessions.has(jid)) {
      throw new Error(`A PTY session is already running for ${jid}`);
    }

    const { bin, args } = buildSpawnArgs(opts.engine, opts.model, {
      resumeId: opts.resumeId,
      sessionId: opts.sessionId,
      fork: opts.fork,
      effort: opts.effort,
    });
    const sessionName = opts.sessionName;
    const log = this.logger.child({ jid, engine: opts.engine });
    log.info(`attaching tmux session "${sessionName}" (${bin} ${args.join(" ")}) in ${opts.cwd}`);

    const attachingToExisting = tmuxSessionExists(sessionName);

    const env = utf8Env();
    let created = false;
    try {
      if (!attachingToExisting) {
        execFileSync(
          "tmux",
          [
            "-u",
            "new-session",
            "-d",
            "-s",
            sessionName,
            "-x",
            String(PTY_COLS),
            "-y",
            String(PTY_ROWS),
            "-c",
            opts.cwd,
            "--",
            bin,
            ...args,
          ],
          { env },
        );
        created = true;
      }
      execFileSync("tmux", ["-u", "set-option", "-t", sessionName, "status", "off"], { env });
      execFileSync("tmux", ["set-option", "-t", sessionName, "window-size", "manual"], { env });
      execFileSync("tmux", ["resize-window", "-t", sessionName, "-x", String(PTY_COLS), "-y", String(PTY_ROWS)], {
        env,
      });
    } catch (err) {
      if (created) this.removeTmuxSession(sessionName);
      throw err;
    }

    let pty: IPty;
    try {
      pty = ptySpawn("tmux", ["-u", "attach-session", "-t", sessionName], {
        name: "xterm-256color",
        cols: PTY_COLS,
        rows: PTY_ROWS,
        cwd: opts.cwd,
        env,
      });
    } catch (err) {
      if (created) this.removeTmuxSession(sessionName);
      throw err;
    }

    const now = Date.now();
    const session: PtySessionHandle = {
      jid,
      sessionName,
      engine: opts.engine,
      claude:
        opts.engine === "claude"
          ? {
              cwd: opts.cwd,
              panePid: null,
              sessionId: opts.fork ? null : (opts.resumeId ?? opts.sessionId ?? null),
              freshFile: !!opts.sessionId && !attachingToExisting,
              expectNewIdentity: !!opts.fork,
              reconstruct: initialPrompt === null,
              tail: null,
              lastTranscriptLookupAt: 0,
              status: null,
              statusSince: now,
              registrySeen: false,
              lastGrowthAt: now,
              turn: null,
              askReported: null,
              askIndex: 0,
              lastProgressAt: now,
              submittedAt: 0,
              lastMenuFrame: null,
              lastTrustAnswerAt: 0,
              timer: null,
            }
          : null,
      codex:
        opts.engine === "codex" ? new CodexObserver(opts.cwd, opts.fork ? null : (opts.resumeId ?? null), now) : null,
      pty,
      frame: new TerminalScreen(PTY_ROWS),
      phase: attachingToExisting ? "running" : "booting",
      pendingInitial: initialPrompt,
      idleTimer: null,
      progressTimer: null,
      lastBootFrame: null,
      bootStartedAt: Date.now(),
      lastEmittedFrame: null,
      modelName: opts.knownModelName ?? null,
      lastKnownEffort: null,
      pendingSteadyBody: null,
      lastReportedBody: null,
      pendingMenu: null,
      detaching: false,
      submitUntil: 0,
      reportBeforeDelivering: attachingToExisting && initialPrompt !== null,
    };
    this.sessions.set(jid, session);
    session.progressTimer = setInterval(() => this.checkProgress(session), this.progressCheckMs);
    if (session.claude) {
      session.claude.timer = setInterval(() => {
        try {
          this.pollClaude(session);
        } catch (err) {
          this.logger.warn(`claude observation failed for ${jid}:`, err);
        }
      }, CLAUDE_POLL_MS);
    }

    pty.onData((data) => {
      if (session.detaching || this.sessions.get(jid) !== session) return;
      this.logger.debug(`[debug-trace ${jid}] received ${data.length} bytes`);
      session.frame.push(data);
      const effort = extractEffort(session.frame.render());
      if (effort) session.lastKnownEffort = effort;
      this.armIdleTimer(session);
    });

    pty.onExit(({ exitCode, signal }) => {
      log.info(`pty exited code=${exitCode} signal=${signal ?? "n/a"}`);
      if (session.idleTimer) clearTimeout(session.idleTimer);
      if (session.progressTimer) clearInterval(session.progressTimer);
      if (session.claude?.timer) clearInterval(session.claude.timer);
      if (this.sessions.get(jid) === session) this.sessions.delete(jid);
      if (!session.detaching) this.emit("exit", jid, exitCode, signal);
    });

    // Fires even if the process stays completely silent, so boot never
    // hangs waiting for output that never comes.
    this.armIdleTimer(session);
  }

  /** Writes a line directly into an already-running session's stdin. */
  send(jid: string, text: string): boolean {
    const session = this.sessions.get(jid);
    if (!session) return false;
    session.lastReportedBody = null; // a fresh turn starts — see progress diffing in onIdle
    session.lastEmittedFrame = null;
    session.frame.resetScrollFlag(); // a fresh turn starts — see session switching and truncation
    if (session.claude) session.claude.submittedAt = Date.now();
    this.pasteAndSubmit(session, text);
    return true;
  }

  answerAsk(jid: string, text: string): boolean {
    const session = this.sessions.get(jid);
    const c = session?.claude;
    const ask = c?.turn?.pendingAsk;
    if (!session || !c || !ask || !c.askReported || c.askReported === "screen") return false;

    const question = ask.questions[c.askIndex] ?? ask.questions[0];
    const optionCount = question?.options.length ?? 0;
    const trimmed = text.trim();
    c.submittedAt = Date.now();
    if (/^\d+$/.test(trimmed) && Number(trimmed) >= 1 && Number(trimmed) <= optionCount) {
      session.pty.write(trimmed);
    } else {
      session.pty.write(String(optionCount + 1)); // "Type something."
      setTimeout(() => {
        if (this.sessions.get(jid) === session) this.pasteAndSubmit(session, text);
      }, 500);
    }

    c.askIndex += 1;
    if (ask.questions.length > 1 && c.askIndex >= ask.questions.length) {
      // A multi-question prompt ends on a review tab that needs its own Enter.
      setTimeout(() => {
        if (this.sessions.get(jid) === session && c.status === "waiting" && c.turn?.pendingAsk === ask)
          session.pty.write("\r");
      }, 1_500);
    }
    return true;
  }

  /** The menu recognized in the last emitted question/ambiguous frame, if any — see parseMenu and sendMenuChoice. */
  getPendingMenu(jid: string): MenuOptions | null {
    return this.sessions.get(jid)?.pendingMenu ?? null;
  }

  sendMenuChoice(jid: string, choice: number): boolean {
    const session = this.sessions.get(jid);
    const menu = session?.pendingMenu;
    if (!session || !menu) return false;
    const target = choice - 1;
    if (target < 0 || target >= menu.count) return false;

    const delta = target - menu.cursorIndex;
    const key = delta > 0 ? "\x1b[B" : "\x1b[A"; // Down / Up arrow
    this.writeAndSubmit(session.pty, key.repeat(Math.abs(delta)));

    session.lastReportedBody = null; // a fresh turn starts — see progress diffing in onIdle
    session.lastEmittedFrame = null; // and a fresh dedup baseline — see send()'s identical reasoning above
    session.frame.resetScrollFlag(); // a fresh turn starts — see session switching and truncation
    session.pendingMenu = null; // answered — the next settled frame decides fresh whether it's a new menu
    if (session.claude) {
      session.claude.submittedAt = Date.now();
      session.claude.lastMenuFrame = null;
    }
    return true;
  }

  cancelPendingInitial(jid: string): boolean {
    const session = this.sessions.get(jid);
    if (!session || session.pendingInitial === null) return false;
    session.pendingInitial = null;
    return true;
  }

  interrupt(jid: string): boolean {
    const session = this.sessions.get(jid);
    if (!session) return false;
    session.pty.write("\x1b");
    return true;
  }

  kill(jid: string, signal: NodeJS.Signals = "SIGTERM"): boolean {
    const session = this.sessions.get(jid);
    if (!session) return false;
    try {
      execFileSync("tmux", ["kill-session", "-t", session.sessionName], { stdio: "ignore" });
    } catch (err) {
      this.logger.warn(`tmux kill-session for ${jid} failed (may already be gone):`, err);
    }
    try {
      session.pty.kill(signal);
    } catch {
      // Already exiting as a result of the tmux session going away.
    }
    return true;
  }

  detach(jid: string): Promise<boolean> {
    const session = this.sessions.get(jid);
    if (!session) return Promise.resolve(false);
    session.detaching = true;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (session.progressTimer) clearInterval(session.progressTimer);
    if (session.claude?.timer) clearInterval(session.claude.timer);
    this.sessions.delete(jid);
    const exited = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      session.pty.onExit(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    try {
      session.pty.kill();
    } catch {
      // Already gone.
    }
    return exited.then(() => true);
  }

  private removeTmuxSession(name: string): void {
    try {
      execFileSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" });
    } catch {
      // The agent may already have exited.
    }
  }

  renameSession(jid: string, newName: string): boolean {
    const session = this.sessions.get(jid);
    if (!session) return false;
    try {
      execFileSync("tmux", ["rename-session", "-t", session.sessionName, newName]);
    } catch (err) {
      this.logger.warn(`tmux rename-session for ${jid} (${session.sessionName} -> ${newName}) failed:`, err);
      return false;
    }
    session.sessionName = newName;
    return true;
  }

  private pasteAndSubmit(session: PtySessionHandle, text: string): void {
    session.codex?.submitted(text);
    session.submitUntil = Date.now() + PASTE_SUBMIT_DELAY_MS + 100;
    const buffer = `wa-bridge-${process.pid}-${Date.now()}`;
    try {
      execFileSync("tmux", ["load-buffer", "-b", buffer, "-"], { input: text, stdio: ["pipe", "ignore", "pipe"] });
      execFileSync("tmux", ["paste-buffer", "-p", "-d", "-b", buffer, "-t", session.sessionName], { stdio: "ignore" });
    } catch (err) {
      this.logger.warn(`tmux paste failed for ${session.jid}, typing directly instead:`, err);
      session.pty.write(text.replace(/\r?\n/g, " "));
    }
    setTimeout(() => {
      if (this.sessions.get(session.jid) === session) session.pty.write("\r");
    }, PASTE_SUBMIT_DELAY_MS);
  }

  private answerTrustDialog(session: PtySessionHandle, rendered: string): boolean {
    if (session.engine !== "claude" || config.permissionMode !== "auto") return false;
    const downs = trustDialogDownPresses(rendered);
    if (downs === null) return false;
    const now = Date.now();
    const c = session.claude;
    if (c && now - c.lastTrustAnswerAt < 3_000) return true; // already answered — waiting for it to close
    if (c) c.lastTrustAnswerAt = now;
    this.logger.info(`[${session.jid}] auto-accepting Claude Code's "trust this folder" dialog`);
    const key = downs >= 0 ? "\x1b[B" : "\x1b[A";
    this.writeAndSubmit(session.pty, key.repeat(Math.abs(downs)));
    return true;
  }

  private emitScreenQuestion(session: PtySessionHandle, rendered: string): void {
    session.pendingMenu = parseMenu(rendered);
    if (session.claude) session.claude.lastMenuFrame = rendered;
    const { body } = extractReply(rendered, session.modelName, session.lastKnownEffort, session.engine);
    this.emit("question", session.jid, body || summarizeFrame(rendered, session.engine), false);
  }

  private pollClaude(session: PtySessionHandle): void {
    const c = session.claude;
    if (!c || this.sessions.get(session.jid) !== session) return;
    const now = Date.now();
    const jid = session.jid;

    if (c.panePid === null) c.panePid = tmuxPanePid(session.sessionName);
    const reg = c.panePid !== null ? readClaudeRegistryForPid(c.panePid) : null;
    if (reg?.status) {
      if (!c.registrySeen) {
        this.logger.info(
          `[${jid}] Claude registry found (pid ${c.panePid}, ${reg.status}) — replies are read from the transcript`,
        );
      }
      c.registrySeen = true;
      if (reg.status !== c.status) {
        this.logger.debug(`[${jid}] claude status ${c.status} -> ${reg.status}`);
        c.status = reg.status;
        c.statusSince = now;
      }
      if (reg.sessionId && reg.sessionId !== c.sessionId) {
        const replaced = c.sessionId !== null;
        c.sessionId = reg.sessionId;
        c.tail = null;
        c.lastTranscriptLookupAt = 0;
        if (replaced) {
          c.freshFile = true;
          c.reconstruct = false;
        }
        if (replaced || c.expectNewIdentity) {
          c.expectNewIdentity = false;
          this.logger.info(`[${jid}] Claude conversation id is now ${reg.sessionId}`);
          this.emit("identityChanged", jid, reg.sessionId);
        }
      }
    }

    if (!c.tail && c.sessionId && now - c.lastTranscriptLookupAt >= 2_000) {
      c.lastTranscriptLookupAt = now;
      const file = findClaudeTranscript(c.sessionId, c.cwd);
      if (file) {
        const start = c.freshFile ? 0 : c.reconstruct ? latestTurnStartOffset(file) : fileSize(file);
        c.reconstruct = false;
        c.tail = new TranscriptTail(file, start);
        this.logger.debug(`[${jid}] reading transcript ${file} from byte ${start}`);
      }
    }

    if (c.tail) {
      const records = c.tail.readNew();
      if (records.length > 0) c.lastGrowthAt = now;
      for (const record of records) {
        if (!c.turn) {
          if (!isUserPrompt(record) && !isAssistantActivity(record)) continue;
          c.turn = new ClaudeTurn();
          c.lastProgressAt = now;
        }
        c.turn.ingest(record);
      }
      const model = c.turn?.model ? prettyModelName(c.turn.model) : null;
      if (model && model !== session.modelName) {
        session.modelName = model;
        this.emit("modelResolved", jid, model);
      }
    }

    if (!c.registrySeen) return; // screen heuristics (onIdle) stay in charge until then
    const quiet = now - c.lastGrowthAt >= CLAUDE_SETTLE_MS;

    if (c.status === "busy") {
      if (!c.turn) {
        c.turn = new ClaudeTurn();
        c.lastProgressAt = now;
      } else if (now - c.lastProgressAt >= this.progressCheckMs && this.isVerbose(jid)) {
        const narration = c.turn.takeNarration();
        if (narration.length > 0) {
          c.lastProgressAt = now;
          this.emit("progress", jid, narration.join("\n\n"), { clean: true, toolCount: c.turn.takeToolDelta() });
        }
      }
      return;
    }

    if (c.status === "waiting") {
      const turn = c.turn ?? (c.turn = new ClaudeTurn());
      const ask = turn.pendingAsk;
      if (ask && c.askReported && !c.askReported.startsWith(`${ask.toolUseId}#`)) {
        c.askIndex = 0;
        c.askReported = null;
      }
      if (ask && c.askIndex >= ask.questions.length) return;
      if (ask && quiet) {
        const key = `${ask.toolUseId}#${c.askIndex}`;
        if (c.askReported !== key) {
          c.askReported = key;
          session.pendingMenu = null;
          const text = [...turn.takeUnsent(), formatAsk(ask, c.askIndex)].join("\n\n");
          this.emit("question", jid, text, false, { clean: true, toolCount: turn.takeToolDelta() });
        }
      } else if (!ask && c.askReported === null && now - c.statusSince >= CLAUDE_WAITING_SCREEN_FALLBACK_MS) {
        c.askReported = "screen";
        this.emitScreenQuestion(session, session.frame.render());
      }
      return;
    }

    // status "idle"
    if (c.turn) {
      const statusIsNewer = c.statusSince >= c.submittedAt || now - c.submittedAt >= CLAUDE_NO_BUSY_FALLBACK_MS;
      if (quiet && now - c.statusSince >= CLAUDE_SETTLE_MS && statusIsNewer) this.completeClaudeTurn(session);
      return;
    }

    if (
      c.submittedAt > 0 &&
      c.statusSince < c.submittedAt &&
      now - c.submittedAt >= CLAUDE_NO_BUSY_FALLBACK_MS &&
      quiet
    ) {
      // Typed something that never became a model turn (a local slash
      // command) — only the screen knows what happened.
      c.submittedAt = 0;
      const rendered = session.frame.render();
      if (frameHasMenu(rendered, "claude")) {
        if (rendered !== c.lastMenuFrame) this.emitScreenQuestion(session, rendered);
      } else {
        const { body } = extractReply(rendered, session.modelName, session.lastKnownEffort, "claude");
        this.emit("complete", jid, body, false, { clean: false, toolCount: 0 });
      }
      return;
    }

    if (
      session.pendingInitial !== null &&
      session.phase === "running" &&
      isReadyForInput(session.frame.render(), "claude")
    ) {
      this.deliverPendingInitial(session);
    }
  }

  private completeClaudeTurn(session: PtySessionHandle): void {
    const c = session.claude!;
    const turn = c.turn!;
    c.turn = null;
    c.askReported = null;
    c.askIndex = 0;
    c.submittedAt = 0;
    session.pendingMenu = null;

    const texts = turn.takeUnsent();
    let text = texts.join("\n\n");
    let clean = true;
    if (!text && turn.localOutput.length > 0) text = turn.localOutput.join("\n\n");
    if (!text && !turn.sawAssistant) {
      text = extractReply(session.frame.render(), session.modelName, session.lastKnownEffort, "claude").body;
      clean = false;
    }
    if (turn.interrupted) text = [text, "⏹️ _Interrupted._"].filter(Boolean).join("\n\n");
    if (!text) text = "✅ _Done._";

    this.logger.info(
      `[${session.jid}] turn complete: ${texts.length} text block(s), ${turn.toolCount} tool call(s)${turn.interrupted ? ", interrupted" : ""}`,
    );
    this.emit("complete", session.jid, text, false, { clean, toolCount: turn.takeToolDelta() });
  }

  /** Writes `text` into the pty, then submits it with its own separate "\r" a beat later — see SUBMIT_DELAY_MS. */
  private writeAndSubmit(pty: IPty, text: string): void {
    pty.write(text);
    setTimeout(() => pty.write("\r"), SUBMIT_DELAY_MS);
  }

  private armIdleTimer(session: PtySessionHandle): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => this.onIdle(session), this.idleMs);
  }

  private reportProgressIfNew(session: PtySessionHandle, body: string, meta: string): void {
    if (body === session.lastReportedBody) return;
    const previous = session.lastReportedBody ?? "";
    const incrementBody = computeProgressIncrement(previous, body);
    session.lastReportedBody = body;
    if (!incrementBody) return;
    const increment = meta ? `${incrementBody}\n_${meta}_` : incrementBody;
    this.emit("progress", session.jid, increment);
  }

  private checkProgress(session: PtySessionHandle): void {
    if (session.claude?.registrySeen) return; // pollClaude reports progress from the transcript instead
    if (session.phase !== "running" || session.pendingInitial !== null) return;
    if (session.codex) {
      session.codex.read();
      if (this.isVerbose(session.jid)) {
        const reply = session.codex.turn.takeProgress();
        if (reply) this.emit("progress", session.jid, reply.text, { clean: true, toolCount: reply.toolCount });
      }
      return;
    }
    const rendered = session.frame.render();
    if (classifyFrame(rendered, session.engine) !== "working") return;
    const { meta, body } = extractReply(rendered, session.modelName, session.lastKnownEffort, session.engine);
    this.reportProgressIfNew(session, body, meta);
  }

  private onIdle(session: PtySessionHandle): void {
    if (session.detaching || this.sessions.get(session.jid) !== session) return;
    session.idleTimer = null;

    if (Date.now() < session.submitUntil) {
      this.armIdleTimer(session); // mid-submission — see submitUntil
      return;
    }

    if (session.phase === "booting") {
      this.onBootIdle(session);
      return;
    }

    const rendered = session.frame.render();

    if (this.answerTrustDialog(session, rendered)) {
      this.armIdleTimer(session);
      return;
    }

    if (session.engine === "claude" && !session.modelName) {
      const found = extractModelName(rendered);
      if (found) {
        session.modelName = found;
        this.emit("modelResolved", session.jid, found);
      }
    }
    if (session.engine === "codex") {
      const found = extractModelNameCodex(rendered);
      if (found && found !== session.modelName) {
        session.modelName = found;
        this.emit("modelResolved", session.jid, found);
      }
    }

    if (session.claude?.registrySeen) {
      const c = session.claude;
      if (c.status === "idle" && !c.turn && frameHasMenu(rendered, "claude") && rendered !== c.lastMenuFrame) {
        this.emitScreenQuestion(session, rendered);
      }
      return;
    }

    const { meta, body } = extractReply(rendered, session.modelName, session.lastKnownEffort, session.engine);
    this.logger.debug(`[debug-trace ${session.jid}] running idle check bodyLength=${body.length}`);

    if (body !== session.pendingSteadyBody) {
      session.pendingSteadyBody = body;
      this.armIdleTimer(session);
      return;
    }

    const classification = classifyFrame(rendered, session.engine);

    if (session.pendingInitial !== null && classification === "complete") {
      if (!session.reportBeforeDelivering) {
        this.deliverPendingInitial(session);
        return;
      }
      session.reportBeforeDelivering = false;
    }

    if (session.codex) {
      session.codex.read();
      if (session.codex.turn.started && classification !== "question" && !body.startsWith("❌")) {
        const reply = session.codex.turn.takeFinal();
        if (reply) {
          session.pendingMenu = null;
          this.emit("complete", session.jid, reply.text || body, false, {
            clean: Boolean(reply.text),
            toolCount: reply.toolCount,
          });
        }
        if (!session.codex.turn.ended) this.armIdleTimer(session);
        return;
      }
    }

    if (classification === "working") {
      // Still actively mid-task (a live "esc to interrupt" hint) — not a
      // final turn boundary, so this never touches lastEmittedFrame/the
      // question-vs-complete dedup above.
      if (!session.codex) this.reportProgressIfNew(session, body, meta);
      this.armIdleTimer(session);
      return;
    }

    const text = meta ? `${body}\n_${meta}_` : body;
    if (text === session.lastEmittedFrame) {
      return;
    }

    session.lastEmittedFrame = text;
    session.lastReportedBody = null; // this turn just ended — the next one starts fresh
    const truncated = session.frame.hasScrolled();

    if (classification === "complete") {
      session.pendingMenu = null; // the turn ended — whatever was pending is answered/moot
      if (session.pendingInitial !== null) {
        this.emit("catchup", session.jid, text, truncated);
        this.deliverPendingInitial(session);
        return;
      }
      this.emit("complete", session.jid, text, truncated);
    } else {
      // Computed from `rendered` (the raw frame), not `body`/`text` above —
      // parseMenu needs the cursor glyph and exact column indentation,
      // which the WhatsApp-facing extraction doesn't promise to preserve.
      session.pendingMenu = parseMenu(rendered);
      this.emit("question", session.jid, text, truncated);
    }
  }

  /** Types a queued initial prompt into a settled, ready-for-input screen — see queued prompt handling in onIdle above. */
  private deliverPendingInitial(session: PtySessionHandle): void {
    const initial = session.pendingInitial;
    session.pendingInitial = null;
    if (initial) {
      this.logger.debug(`[debug-trace ${session.jid}] writing initial prompt (${initial.length} characters)`);
      session.lastReportedBody = null; // a fresh turn starts — see progress diffing in onIdle
      session.lastEmittedFrame = null; // and a fresh dedup baseline — see send()'s identical reasoning
      session.frame.resetScrollFlag();
      if (session.claude) session.claude.submittedAt = Date.now();
      this.pasteAndSubmit(session, initial);
    }
    this.armIdleTimer(session);
  }

  private onBootIdle(session: PtySessionHandle): void {
    const elapsed = Date.now() - session.bootStartedAt;
    const rendered = session.frame.render();
    if (this.answerTrustDialog(session, rendered)) {
      session.lastBootFrame = null;
      this.armIdleTimer(session);
      return;
    }
    const contentStable = session.lastBootFrame !== null && rendered === session.lastBootFrame;
    const settled = contentStable && elapsed >= BOOT_MIN_WAIT_MS;
    const timedOut = elapsed > BOOT_MAX_WAIT_MS;
    this.logger.debug(
      `[debug-trace ${session.jid}] boot idle check elapsed=${elapsed}ms contentStable=${contentStable} settled=${settled} timedOut=${timedOut}`,
    );

    if (!settled && !timedOut) {
      session.lastBootFrame = rendered;
      this.armIdleTimer(session);
      return;
    }

    session.phase = "running";
    if (session.engine === "claude" || session.engine === "codex") {
      const found = session.engine === "codex" ? extractModelNameCodex(rendered) : extractModelName(rendered);
      if (found && found !== session.modelName) {
        session.modelName = found;
        this.emit("modelResolved", session.jid, found);
      }
    }
    this.armIdleTimer(session);
  }
}
