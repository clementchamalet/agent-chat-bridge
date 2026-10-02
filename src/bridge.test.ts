import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveredSession } from "./discovery/sessions.js";
import type { SessionRecord } from "./types.js";
import type { SendTextOptions } from "./channel/types.js";
import * as discovery from "./discovery/sessions.js";
import { Bridge } from "./bridge.js";

const JID = "bridge-test-jid";

function fakeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    jid: JID,
    workingDir: "/tmp/project",
    engine: "claude",
    model: null,
    effort: null,
    state: "IDLE",
    ptyPid: null,
    waitingSince: null,
    tmuxSession: "wa-claude-current",
    resumeId: "current-resume-id",
    title: null,
    started: true,
    verbose: false,
    resolvedModel: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeBridge(initialSessions: SessionRecord[] = [], opts: { tmuxAlive?: boolean; jid?: string } = {}) {
  const whatsapp = new EventEmitter();
  const ptyManager = Object.assign(new EventEmitter(), {
    isAlive: vi.fn(() => false),
    isTmuxSessionAlive: vi.fn(() => opts.tmuxAlive ?? true),
    start: vi.fn(),
    send: vi.fn(),
    sendMenuChoice: vi.fn(() => false),
    cancelPendingInitial: vi.fn(() => false),
    getPendingMenu: vi.fn(() => null),
    detach: vi.fn(),
    getPid: vi.fn(() => 123),
    renameSession: vi.fn(() => true),
    kill: vi.fn(),
  });
  const sentTexts: string[] = [];
  let sessionState = fakeSession({ jid: opts.jid ?? JID });

  const sessionRepo = {
    listAll: vi.fn(() => initialSessions),
    getOrCreate: vi.fn(() => sessionState),
    get: vi.fn(() => sessionState),
    update: vi.fn((_jid: string, patch: Partial<SessionRecord>) => {
      sessionState = { ...sessionState, ...patch };
      return sessionState;
    }),
    setState: vi.fn((_jid: string, state: SessionRecord["state"], extra: Partial<SessionRecord> = {}) => {
      sessionState = { ...sessionState, state, ...extra };
      return sessionState;
    }),
  };

  const reactions: { emoji: string; key: string }[] = [];
  const sender = {
    sendText: vi.fn(async (_jid: string, text: string, _options?: SendTextOptions) => {
      sentTexts.push(text);
      return "msg-id";
    }),
    react: vi.fn(async (_jid: string, emoji: string, key: string) => {
      reactions.push({ emoji, key });
    }),
    sendDocument: vi.fn(async () => {}),
    downloadMedia: vi.fn(async () => ({ buffer: Buffer.from("fake-image-bytes"), mimeType: "image/jpeg" })),
  };

  const sessionPicker = {
    show: vi.fn(),
    clear: vi.fn(),
    has: vi.fn(() => false),
    resolve: vi.fn(() => null),
    peekAt: vi.fn(() => null),
    renderPage: vi.fn(() => null),
  };
  const filePicker = {
    show: vi.fn(),
    clear: vi.fn(),
    has: vi.fn(() => false),
    resolve: vi.fn(() => null),
    renderPage: vi.fn(() => null),
  };
  const repoPicker = {
    show: vi.fn(),
    clear: vi.fn(),
    has: vi.fn(() => false),
    resolve: vi.fn(() => null),
    renderPage: vi.fn(() => null),
  };
  const freeWatches: { jid: string; target: unknown }[] = [];
  const watchForFree = vi.fn((jid: string, target: unknown) => freeWatches.push({ jid, target }));

  const bridge = new Bridge({
    source: whatsapp as never,
    ptyManager: ptyManager as never,
    sessionRepo: sessionRepo as never,
    sender: sender as never,
    sessionPicker: sessionPicker as never,
    filePicker: filePicker as never,
    repoPicker: repoPicker as never,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    } as never,
    watchForFree,
  });
  bridge.wire();

  return {
    bridge,
    whatsapp,
    ptyManager,
    sessionRepo,
    sender,
    sessionPicker,
    filePicker,
    repoPicker,
    sentTexts,
    reactions,
    watchForFree,
    freeWatches,
    getState: () => sessionState,
  };
}

describe("Bridge state machine", () => {
  it("resolves a Codex conversation created after the startup discovery window", async () => {
    vi.useFakeTimers();
    const discover = vi.spyOn(discovery, "discoverCodexSessions").mockReturnValue([]);
    try {
      const { whatsapp, ptyManager, sessionRepo, getState } = makeBridge();
      sessionRepo.update(JID, {
        engine: "codex",
        resumeId: null,
        started: false,
        tmuxSession: "wa-codex-pending-test",
      });
      whatsapp.emit("message", { jid: JID, text: "work", key: "1" });
      await vi.advanceTimersByTimeAsync(3100);
      expect(getState().resumeId).toBeNull();
      discover.mockReturnValue([
        {
          engine: "codex",
          resumeId: "late-session",
          tmuxSession: "wa-codex-late-session",
          directory: "/tmp/project",
          title: "Work",
          updatedAt: Date.now(),
          live: false,
          activeElsewhere: false,
        },
      ]);
      ptyManager.emit("complete", JID, "Done.", false);
      await vi.advanceTimersByTimeAsync(600);
      expect(getState()).toMatchObject({
        resumeId: "late-session",
        tmuxSession: "wa-codex-late-session",
        state: "IDLE",
      });
      expect(ptyManager.renameSession).toHaveBeenCalledWith(JID, "wa-codex-late-session");
    } finally {
      discover.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([JID, "tg:123"])("marks only agent replies for metadata in %s", async (jid) => {
    const { whatsapp, ptyManager, sender, getState } = makeBridge([], { jid });
    const receive = async (text: string, key: string) => {
      whatsapp.emit("message", { jid, text, key });
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    await receive("/help", "1");
    expect(sender.sendText.mock.lastCall?.[1]).toContain("Available commands:");
    expect(sender.sendText.mock.lastCall?.[2]).toBeUndefined();

    await receive("work", "2");
    expect(getState().state).toBe("EXECUTING");
    await receive("/help", "3");
    await receive("/status", "4");
    for (const [, , options] of sender.sendText.mock.calls) {
      expect(options?.agentReply).not.toBe(true);
    }

    ptyManager.emit("complete", jid, "Done.", false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sender.sendText).toHaveBeenLastCalledWith(jid, "Done.", { agentReply: true });
  });

  it("drops old agent events queued during a conversation switch", async () => {
    const { whatsapp, ptyManager, sentTexts, getState } = makeBridge();
    let release!: () => void;
    ptyManager.isAlive.mockReturnValue(true);
    ptyManager.detach.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    whatsapp.emit("message", { jid: JID, text: `/new ${os.tmpdir()}`, key: "1" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    ptyManager.emit("complete", JID, "Old conversation reply", false);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sentTexts).not.toContain("Old conversation reply");
    expect(getState().state).toBe("IDLE");
  });
  it("recovers from a failed final delivery and allows the same payload to retry", async () => {
    const { whatsapp, ptyManager, sender, getState, sentTexts } = makeBridge();
    whatsapp.emit("message", { jid: JID, text: "work", key: "1" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    sender.sendText.mockRejectedValueOnce(new Error("Channel unavailable"));
    ptyManager.emit("complete", JID, "Done.", false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getState().state).toBe("IDLE");
    ptyManager.emit("complete", JID, "Done.", false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sentTexts).toContain("Done.");
    expect(sender.sendText).toHaveBeenCalledTimes(2);
  });

  it("discards messages queued during execution", async () => {
    const { whatsapp, ptyManager, getState, sentTexts } = makeBridge();
    whatsapp.emit("message", { jid: JID, text: "work", key: "1" });
    whatsapp.emit("message", { jid: JID, text: "queued", key: "2" });
    whatsapp.emit("message", { jid: JID, text: "/discard", key: "3" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    ptyManager.emit("complete", JID, "Done.", false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ptyManager.start).toHaveBeenCalledTimes(1);
    expect(getState().state).toBe("IDLE");
    expect(sentTexts).toContain("🗑️ Queued messages discarded.");
  });

  it("bounds the execution queue", async () => {
    const { whatsapp, reactions, sentTexts } = makeBridge();
    whatsapp.emit("message", { jid: JID, text: "work", key: "1" });
    for (let i = 0; i < 21; i++) whatsapp.emit("message", { jid: JID, text: "queued", key: String(i + 2) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reactions.filter((reaction) => reaction.emoji === "📥")).toHaveLength(20);
    expect(sentTexts.some((text) => text.includes("queue is full"))).toBe(true);
  });

  it("does not report successful delivery when the agent fails to start", async () => {
    const { whatsapp, ptyManager, reactions, getState } = makeBridge();
    ptyManager.start.mockImplementation(() => {
      throw new Error("Missing executable");
    });
    whatsapp.emit("message", { jid: JID, text: "work", key: "1" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getState().state).toBe("IDLE");
    expect(reactions.some((reaction) => reaction.emoji === "✅")).toBe(false);
  });

  it("counts attached idle sessions against the process limit", async () => {
    const { whatsapp, ptyManager, sessionRepo, sentTexts } = makeBridge();
    sessionRepo.listAll.mockReturnValue(Array.from({ length: 8 }, (_, i) => fakeSession({ jid: `other-${i}` })));
    ptyManager.isAlive.mockImplementation((jid?: string) => jid !== JID);
    whatsapp.emit("message", { jid: JID, text: "work", key: "1" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ptyManager.start).not.toHaveBeenCalled();
    expect(sentTexts.some((text) => text.includes("already active"))).toBe(true);
  });

  it("stops accepting events after draining pending work", async () => {
    const { bridge, whatsapp, ptyManager } = makeBridge();
    whatsapp.emit("message", { jid: JID, text: "work", key: "1" });
    await bridge.stop();
    whatsapp.emit("message", { jid: JID, text: "ignored", key: "2" });
    ptyManager.emit("question", JID, "ignored", false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ptyManager.start).toHaveBeenCalledTimes(1);
  });

  it("reports a missing agent executable to the chat", async () => {
    const { whatsapp, ptyManager, sentTexts } = makeBridge();
    ptyManager.start.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    whatsapp.emit("message", { jid: JID, text: "Start work", key: "k1" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sentTexts.some((text) => text.includes("Could not start claude") && text.includes("PATH"))).toBe(true);
  });

  describe("boot reconciliation (reattaching to a session survived from before a restart)", () => {
    it("silently reattaches to a session left EXECUTING at shutdown when its tmux session is still alive", () => {
      const survivor = fakeSession({ jid: "survivor-jid", state: "EXECUTING", tmuxSession: "wa-claude-survivor" });
      const { ptyManager, sessionRepo } = makeBridge([survivor]);

      expect(ptyManager.start).toHaveBeenCalledWith(
        "survivor-jid",
        expect.objectContaining({
          sessionName: "wa-claude-survivor",
          engine: survivor.engine,
          cwd: survivor.workingDir,
        }),
        null,
      );
      expect(sessionRepo.setState).toHaveBeenCalledWith("survivor-jid", "EXECUTING", expect.anything());
    });

    it("silently reattaches to a session left WAITING_FOR_INPUT at shutdown, the same as an EXECUTING one", () => {
      const survivor = fakeSession({
        jid: "survivor-jid",
        state: "WAITING_FOR_INPUT",
        tmuxSession: "wa-claude-survivor",
      });
      const { ptyManager } = makeBridge([survivor]);

      expect(ptyManager.start).toHaveBeenCalledWith("survivor-jid", expect.anything(), null);
    });

    it("does not reattach a busy session whose tmux session no longer exists (a genuine crash/reboot, not a graceful restart)", () => {
      const dead = fakeSession({ jid: "dead-jid", state: "WAITING_FOR_INPUT", tmuxSession: "wa-claude-dead" });
      const { ptyManager } = makeBridge([dead], { tmuxAlive: false });

      expect(ptyManager.start).not.toHaveBeenCalled();
    });

    it("does not reattach a session that was already IDLE at shutdown", () => {
      const idle = fakeSession({ jid: "idle-jid", state: "IDLE", tmuxSession: "wa-claude-idle" });
      const { ptyManager } = makeBridge([idle]);

      expect(ptyManager.start).not.toHaveBeenCalled();
    });

    it("preserves watchdog timestamps while reattaching", () => {
      const started = new Date(Date.now() - 3_600_000).toISOString();
      const waiting = new Date(Date.now() - 600_000).toISOString();
      const { sessionRepo } = makeBridge([
        fakeSession({ jid: "executing", state: "EXECUTING", executionStartedAt: started }),
        fakeSession({ jid: "waiting", state: "WAITING_FOR_INPUT", waitingSince: waiting }),
      ]);
      expect(sessionRepo.setState).toHaveBeenCalledWith(
        "executing",
        "EXECUTING",
        expect.objectContaining({ executionStartedAt: started }),
      );
      expect(sessionRepo.setState).toHaveBeenCalledWith(
        "waiting",
        "WAITING_FOR_INPUT",
        expect.objectContaining({ waitingSince: waiting }),
      );
    });
  });

  it("sends the reply and returns to IDLE on a completion event", async () => {
    const { whatsapp, ptyManager, sentTexts, getState } = makeBridge();
    whatsapp.emit("message", { jid: JID, text: "write a report", key: "k1" });
    await new Promise((r) => setTimeout(r, 0));

    ptyManager.emit("complete", JID, "The task is complete.");
    await new Promise((r) => setTimeout(r, 0));

    expect(sentTexts).toContain("The task is complete.");
    expect(getState().state).toBe("IDLE");
  });

  it("sends no intermediate progress when verbose is off and sends one final reply", async () => {
    const { whatsapp, ptyManager, sentTexts } = makeBridge();
    whatsapp.emit("message", { jid: JID, text: "complete a small task", key: "k1" });
    await new Promise((r) => setTimeout(r, 0));

    ptyManager.emit("progress", JID, "_Bash(echo secret)_\nThe task is still running.");
    ptyManager.emit("progress", JID, "_Bash(echo secret)_\nThe task is still running.");
    await new Promise((r) => setTimeout(r, 0));
    expect(sentTexts).toHaveLength(0);

    ptyManager.emit("complete", JID, "_Bash(echo secret)_\nTask complete.");
    ptyManager.emit("complete", JID, "_Bash(echo secret)_\nTask complete.");
    await new Promise((r) => setTimeout(r, 0));

    expect(sentTexts).toEqual(["> (1 command run)\n\nTask complete."]);
  });

  it("sends a verbose block as counter followed by the agent intent", async () => {
    const { whatsapp, ptyManager, sentTexts, sessionRepo } = makeBridge();
    whatsapp.emit("message", { jid: JID, text: "complete a small task", key: "k1" });
    await new Promise((r) => setTimeout(r, 0));
    sessionRepo.update(JID, { verbose: true });

    ptyManager.emit("progress", JID, "_Write(tables.py)_\nThe requested file has been updated.");
    await new Promise((r) => setTimeout(r, 0));

    expect(sentTexts).toEqual(["> (1 command run)\n\nThe requested file has been updated."]);
  });

  describe("session-change prefix", () => {
    it("adds no prefix to the very first message sent on a jid", async () => {
      const { whatsapp, ptyManager, sentTexts } = makeBridge();
      whatsapp.emit("message", { jid: JID, text: "write a report", key: "k1" });
      await new Promise((r) => setTimeout(r, 0));
      ptyManager.emit("complete", JID, "Done.", false);
      await new Promise((r) => setTimeout(r, 0));

      expect(sentTexts).toContain("Done.");
    });

    it("adds no prefix across consecutive messages from the same session", async () => {
      const { whatsapp, ptyManager, sentTexts } = makeBridge();
      whatsapp.emit("message", { jid: JID, text: "one", key: "k1" });
      await new Promise((r) => setTimeout(r, 0));
      ptyManager.emit("complete", JID, "First.", false);
      await new Promise((r) => setTimeout(r, 0));

      whatsapp.emit("message", { jid: JID, text: "two", key: "k2" });
      await new Promise((r) => setTimeout(r, 0));
      ptyManager.emit("complete", JID, "Second.", false);
      await new Promise((r) => setTimeout(r, 0));

      expect(sentTexts).toContain("Second.");
    });

    it("prefixes with project/title once the session changes since the last message", async () => {
      const { whatsapp, ptyManager, sentTexts, sessionRepo, getState } = makeBridge();
      whatsapp.emit("message", { jid: JID, text: "one", key: "k1" });
      await new Promise((r) => setTimeout(r, 0));
      ptyManager.emit("complete", JID, "First.", false);
      await new Promise((r) => setTimeout(r, 0));

      sessionRepo.update(JID, { tmuxSession: "wa-claude-other-session", workingDir: "/tmp/other", title: "Other" });
      expect(getState().tmuxSession).toBe("wa-claude-other-session");

      ptyManager.emit("complete", JID, "Second project.", false);
      await new Promise((r) => setTimeout(r, 0));

      const last = sentTexts[sentTexts.length - 1]!;
      expect(last).toMatch(/^▸ other · Other\nSecond project\.$/);
    });

    it("appends a truncation note when the reply may be missing its beginning", async () => {
      const { whatsapp, ptyManager, sentTexts } = makeBridge();
      whatsapp.emit("message", { jid: JID, text: "one", key: "k1" });
      await new Promise((r) => setTimeout(r, 0));
      ptyManager.emit("complete", JID, "Long reply.", true);
      await new Promise((r) => setTimeout(r, 0));

      expect(sentTexts.some((t) => t.includes("Long reply.") && t.includes("truncated"))).toBe(true);
    });
  });

  describe("identity on fresh spawn", () => {
    it("mints the conversation fresh with --session-id on its very first spawn", async () => {
      const { whatsapp, ptyManager, sessionRepo } = makeBridge();
      sessionRepo.getOrCreate.mockReturnValue(fakeSession({ started: false, resumeId: "brand-new-id" }));

      whatsapp.emit("message", { jid: JID, text: "hello", key: "k1" });
      await new Promise((r) => setTimeout(r, 0));

      expect(ptyManager.start).toHaveBeenCalledWith(
        JID,
        expect.objectContaining({ sessionId: "brand-new-id", resumeId: undefined }),
        "hello",
      );
    });

    it("resumes existing history with --resume once already started — the dead-tmux-session relaunch case", async () => {
      const { whatsapp, ptyManager, sessionRepo } = makeBridge();
      sessionRepo.getOrCreate.mockReturnValue(fakeSession({ started: true, resumeId: "existing-id" }));

      whatsapp.emit("message", { jid: JID, text: "continue the refactor", key: "k1" });
      await new Promise((r) => setTimeout(r, 0));

      expect(ptyManager.start).toHaveBeenCalledWith(
        JID,
        expect.objectContaining({ resumeId: "existing-id", sessionId: undefined }),
        "continue the refactor",
      );
    });
  });

  describe("persisted model name (SessionRecord.resolvedModel)", () => {
    it("persists a model name the moment PtyManager resolves one, so it survives a restart", async () => {
      const { ptyManager, sessionRepo } = makeBridge();

      ptyManager.emit("modelResolved", JID, "Sonnet 5");
      await new Promise((r) => setTimeout(r, 0));

      expect(sessionRepo.update).toHaveBeenCalledWith(JID, { resolvedModel: "Sonnet 5" });
    });

    it("seeds a fresh spawn's knownModelName from the session's already-persisted resolvedModel", async () => {
      const { whatsapp, ptyManager, sessionRepo } = makeBridge();
      sessionRepo.getOrCreate.mockReturnValue(
        fakeSession({ started: true, resumeId: "existing-id", resolvedModel: "Sonnet 5" }),
      );

      whatsapp.emit("message", { jid: JID, text: "continue", key: "k1" });
      await new Promise((r) => setTimeout(r, 0));

      expect(ptyManager.start).toHaveBeenCalledWith(
        JID,
        expect.objectContaining({ knownModelName: "Sonnet 5" }),
        "continue",
      );
    });

    it("clears resolvedModel when switching to a different session — the previous conversation's cached name doesn't apply to the new one", async () => {
      const { whatsapp, ptyManager, sessionPicker, sessionRepo } = makeBridge();
      sessionRepo.getOrCreate.mockReturnValue(fakeSession({ resolvedModel: "Sonnet 5" }));

      const target: DiscoveredSession = {
        engine: "claude",
        resumeId: "target-id",
        directory: os.tmpdir(),
        title: "Another session",
        updatedAt: Date.now(),
        live: false,
        tmuxSession: "wa-claude-target",
        activeElsewhere: false,
      };
      (sessionPicker.has as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (sessionPicker.resolve as ReturnType<typeof vi.fn>).mockReturnValue(target);

      whatsapp.emit("message", { jid: JID, text: "1", key: "k1" });
      await new Promise((r) => setTimeout(r, 0));

      expect(sessionRepo.update).toHaveBeenCalledWith(JID, expect.objectContaining({ resolvedModel: null }));
      expect(ptyManager.start).toHaveBeenCalledWith(
        JID,
        expect.not.objectContaining({ knownModelName: "Sonnet 5" }),
        null,
      );
    });
  });

  describe("OpenCode identity resolution", () => {
    let binDir: string;
    let originalPath: string;

    beforeEach(() => {
      binDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-opencode-identity-bin-"));
      originalPath = process.env.PATH ?? "";
      process.env.PATH = `${binDir}:${originalPath}`;
    });

    afterEach(() => {
      process.env.PATH = originalPath;
      fs.rmSync(binDir, { recursive: true, force: true });
    });

    it("does not rename a replacement conversation when identity discovery finishes late", async () => {
      const cwd = os.tmpdir();
      const shim = path.join(binDir, "opencode");
      fs.writeFileSync(
        shim,
        `#!/usr/bin/env node\nconsole.log(JSON.stringify([{ id: "ses_late", updated: Date.now(), directory: ${JSON.stringify(cwd)} }]));\n`,
      );
      fs.chmodSync(shim, 0o755);
      const { whatsapp, ptyManager, sessionRepo } = makeBridge();
      const session = fakeSession({
        engine: "opencode",
        resumeId: null,
        started: false,
        workingDir: cwd,
        tmuxSession: "wa-opencode-pending-old",
      });
      sessionRepo.getOrCreate.mockReturnValue(session);
      sessionRepo.get.mockReturnValue(session);
      whatsapp.emit("message", { jid: JID, text: "work", key: "1" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      sessionRepo.get.mockReturnValue({ ...session, tmuxSession: "wa-opencode-replacement" });
      await new Promise((resolve) => setTimeout(resolve, 650));
      expect(ptyManager.renameSession).not.toHaveBeenCalled();
    });

    it("resolves the real session id after the fact and renames the tmux session", async () => {
      const cwd = os.tmpdir();
      const shim = path.join(binDir, "opencode");
      fs.writeFileSync(
        shim,
        `#!/usr/bin/env node\nconsole.log(JSON.stringify([{ id: "ses_resolved123", title: "t", updated: Date.now(), directory: ${JSON.stringify(cwd)} }]));\n`,
      );
      fs.chmodSync(shim, 0o755);

      const { whatsapp, ptyManager, sessionRepo } = makeBridge();
      const session = fakeSession({
        engine: "opencode",
        resumeId: null,
        started: false,
        workingDir: cwd,
        tmuxSession: "wa-opencode-pending-x",
      });
      sessionRepo.getOrCreate.mockReturnValue(session);
      sessionRepo.get.mockReturnValue(session);

      whatsapp.emit("message", { jid: JID, text: "hello", key: "k1" });
      await new Promise((r) => setTimeout(r, 0));

      await new Promise((r) => setTimeout(r, 1200));

      expect(ptyManager.renameSession).toHaveBeenCalledWith(JID, "wa-opencode-ses_resolved123");
      expect(sessionRepo.update).toHaveBeenCalledWith(
        JID,
        expect.objectContaining({ tmuxSession: "wa-opencode-ses_resolved123", resumeId: "ses_resolved123" }),
      );
    });
  });

  it("moves to WAITING_FOR_INPUT and mirrors the question text on a question event", async () => {
    const { whatsapp, ptyManager, sentTexts, getState } = makeBridge();
    whatsapp.emit("message", { jid: JID, text: "write a report", key: "k1" });
    await new Promise((r) => setTimeout(r, 0));

    ptyManager.emit("question", JID, "Which format do you prefer?");
    await new Promise((r) => setTimeout(r, 0));

    expect(sentTexts).toContain("Which format do you prefer?");
    expect(getState().state).toBe("WAITING_FOR_INPUT");
  });

  it("falls back to a placeholder instead of sending a blank message when the frame text is empty", async () => {
    const { whatsapp, ptyManager, sentTexts } = makeBridge();
    whatsapp.emit("message", { jid: JID, text: "write a report", key: "k1" });
    await new Promise((r) => setTimeout(r, 0));

    ptyManager.emit("question", JID, "");
    await new Promise((r) => setTimeout(r, 0));

    expect(sentTexts.some((t) => t.trim().length > 0)).toBe(true);
  });

  it("forwards an answer while WAITING_FOR_INPUT and moves back to EXECUTING", async () => {
    const { whatsapp, ptyManager, getState } = makeBridge();
    whatsapp.emit("message", { jid: JID, text: "write a report", key: "k1" });
    await new Promise((r) => setTimeout(r, 0));
    ptyManager.emit("question", JID, "Which format?");
    await new Promise((r) => setTimeout(r, 0));

    ptyManager.isAlive.mockReturnValue(true);
    whatsapp.emit("message", { jid: JID, text: "markdown", key: "k2" });
    await new Promise((r) => setTimeout(r, 0));

    expect(ptyManager.send).toHaveBeenCalledWith(JID, "markdown");
    expect(getState().state).toBe("EXECUTING");
  });

  it("tries sendMenuChoice for a bare-digit reply while WAITING_FOR_INPUT, and skips the literal send when it succeeds", async () => {
    const { whatsapp, ptyManager, getState } = makeBridge();
    whatsapp.emit("message", { jid: JID, text: "write a report", key: "k1" });
    await new Promise((r) => setTimeout(r, 0));
    ptyManager.emit("question", JID, "Trust this folder?");
    await new Promise((r) => setTimeout(r, 0));

    (ptyManager.sendMenuChoice as ReturnType<typeof vi.fn>).mockReturnValue(true);
    whatsapp.emit("message", { jid: JID, text: "2", key: "k2" });
    await new Promise((r) => setTimeout(r, 0));

    expect(ptyManager.sendMenuChoice).toHaveBeenCalledWith(JID, 2);
    expect(ptyManager.send).not.toHaveBeenCalled();
    expect(getState().state).toBe("EXECUTING");
  });

  it("falls back to a literal send when a digit reply doesn't match a recognized menu", async () => {
    const { whatsapp, ptyManager } = makeBridge();
    whatsapp.emit("message", { jid: JID, text: "write a report", key: "k1" });
    await new Promise((r) => setTimeout(r, 0));
    ptyManager.emit("question", JID, "How many files?");
    await new Promise((r) => setTimeout(r, 0));

    whatsapp.emit("message", { jid: JID, text: "3", key: "k2" });
    await new Promise((r) => setTimeout(r, 0));

    expect(ptyManager.sendMenuChoice).toHaveBeenCalledWith(JID, 3);
    expect(ptyManager.send).toHaveBeenCalledWith(JID, "3");
  });

  it("refuses a non-numeric reply to a recognized menu instead of forwarding it as literal text", async () => {
    const { whatsapp, ptyManager, sentTexts, getState } = makeBridge();
    whatsapp.emit("message", { jid: JID, text: "write a report", key: "k1" });
    await new Promise((r) => setTimeout(r, 0));
    ptyManager.emit("question", JID, "Trust this folder?");
    await new Promise((r) => setTimeout(r, 0));

    (ptyManager.getPendingMenu as ReturnType<typeof vi.fn>).mockReturnValue({ cursorIndex: 0, count: 2 });
    whatsapp.emit("message", { jid: JID, text: "yes", key: "k2" });
    await new Promise((r) => setTimeout(r, 0));

    expect(ptyManager.send).not.toHaveBeenCalled();
    expect(ptyManager.sendMenuChoice).not.toHaveBeenCalled();
    expect(getState().state).toBe("WAITING_FOR_INPUT");
    expect(sentTexts.some((t) => t.includes("option number from 1 to 2"))).toBe(true);
  });

  it("refuses an out-of-range digit reply to a recognized menu instead of forwarding it as literal text", async () => {
    const { whatsapp, ptyManager, getState } = makeBridge();
    whatsapp.emit("message", { jid: JID, text: "write a report", key: "k1" });
    await new Promise((r) => setTimeout(r, 0));
    ptyManager.emit("question", JID, "Trust this folder?");
    await new Promise((r) => setTimeout(r, 0));

    (ptyManager.getPendingMenu as ReturnType<typeof vi.fn>).mockReturnValue({ cursorIndex: 0, count: 2 });
    whatsapp.emit("message", { jid: JID, text: "5", key: "k2" });
    await new Promise((r) => setTimeout(r, 0));

    expect(ptyManager.send).not.toHaveBeenCalled();
    expect(getState().state).toBe("WAITING_FOR_INPUT");
  });

  it("runs a passive command like /verbose immediately while EXECUTING instead of queueing it", async () => {
    const { whatsapp, ptyManager, sentTexts, sessionRepo, getState } = makeBridge();
    whatsapp.emit("message", { jid: JID, text: "write a report", key: "k1" });
    await new Promise((r) => setTimeout(r, 0));
    expect(getState().state).toBe("EXECUTING");

    whatsapp.emit("message", { jid: JID, text: "/verbose off", key: "k2" });
    await new Promise((r) => setTimeout(r, 0));

    expect(ptyManager.send).not.toHaveBeenCalled();
    expect(sessionRepo.update).toHaveBeenCalledWith(JID, { verbose: false });
    expect(sentTexts.some((t) => t.includes("Progress updates disabled"))).toBe(true);
    expect(getState().state).toBe("EXECUTING");
  });

  it("runs a passive command like /status immediately while WAITING_FOR_INPUT instead of typing it as a literal answer to the pending question", async () => {
    const { whatsapp, ptyManager, sentTexts, getState } = makeBridge();
    whatsapp.emit("message", { jid: JID, text: "write a report", key: "k1" });
    await new Promise((r) => setTimeout(r, 0));
    ptyManager.emit("question", JID, "Which format do you prefer?");
    await new Promise((r) => setTimeout(r, 0));

    whatsapp.emit("message", { jid: JID, text: "/status", key: "k2" });
    await new Promise((r) => setTimeout(r, 0));

    expect(ptyManager.send).not.toHaveBeenCalled();
    expect(sentTexts.some((t) => t.includes("state:"))).toBe(true);
    expect(getState().state).toBe("WAITING_FOR_INPUT");
  });

  it("serializes a PTY exit against an in-flight WAITING_FOR_INPUT reply instead of racing it", async () => {
    const { whatsapp, ptyManager, sender, sessionRepo, getState } = makeBridge();
    sessionRepo.update(JID, { state: "WAITING_FOR_INPUT" });

    let resolveReact!: () => void;
    const reactGate = new Promise<void>((resolve) => {
      resolveReact = resolve;
    });
    (sender.react as ReturnType<typeof vi.fn>).mockImplementation(async (_jid: string, emoji: string) => {
      if (emoji === "✅") await reactGate;
    });

    whatsapp.emit("message", { jid: JID, text: "2", key: "k1" });
    await new Promise((r) => setTimeout(r, 0));

    ptyManager.emit("exit", JID, 0, undefined);
    await new Promise((r) => setTimeout(r, 0));

    resolveReact();
    await new Promise((r) => setTimeout(r, 0));

    expect(getState().state).toBe("IDLE");
  });

  it("switches to a picked session — detaches current, starts the target, sends a confirmation", async () => {
    const { whatsapp, ptyManager, sessionPicker, sentTexts, getState } = makeBridge();
    const otherDir = os.tmpdir();
    const target: DiscoveredSession = {
      engine: "opencode",
      resumeId: "ses_abc",
      directory: otherDir,
      title: "Another project",
      updatedAt: Date.now(),
      live: false,
      tmuxSession: "wa-opencode-ses_abc",
      activeElsewhere: false,
    };
    (sessionPicker.has as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (sessionPicker.resolve as ReturnType<typeof vi.fn>).mockReturnValue(target);
    ptyManager.isAlive.mockReturnValue(true);

    whatsapp.emit("message", { jid: JID, text: "2", key: "k1" });
    await new Promise((r) => setTimeout(r, 0));

    expect(ptyManager.detach).toHaveBeenCalledWith(JID);
    expect(ptyManager.start).toHaveBeenCalledWith(
      JID,
      expect.objectContaining({ engine: "opencode", cwd: otherDir, resumeId: "ses_abc" }),
      null,
    );
    expect(getState().workingDir).toBe(otherDir);
    expect(sentTexts.some((t) => t.includes("Another project"))).toBe(true);
  });

  it("'#3' picks a session non-destructively — usable even when has()/resolve() alone would say the list is gone", async () => {
    const { whatsapp, ptyManager, sessionPicker, sentTexts } = makeBridge();
    const otherDir = os.tmpdir();
    const target: DiscoveredSession = {
      engine: "claude",
      resumeId: "hash-pick-id",
      directory: otherDir,
      title: "Picked via hash",
      updatedAt: Date.now(),
      live: false,
      tmuxSession: "wa-claude-hash-pick-id",
      activeElsewhere: false,
    };
    (sessionPicker.has as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (sessionPicker.peekAt as ReturnType<typeof vi.fn>).mockImplementation((_jid: string, n: number) =>
      n === 3 ? target : null,
    );

    whatsapp.emit("message", { jid: JID, text: "#3", key: "k1" });
    await new Promise((r) => setTimeout(r, 0));

    expect(sessionPicker.peekAt).toHaveBeenCalledWith(JID, 3);
    expect(ptyManager.start).toHaveBeenCalledWith(JID, expect.objectContaining({ cwd: otherDir }), null);
    expect(sentTexts.some((t) => t.includes("Picked via hash"))).toBe(true);
  });

  it("picking from /repo switches just the directory, keeping the current session's engine/model/effort (D-repo)", async () => {
    const { whatsapp, sessionRepo, repoPicker, sentTexts } = makeBridge();
    const newDir = os.tmpdir();
    sessionRepo.update(JID, { engine: "opencode", model: "custom-model", effort: "high" });
    (repoPicker.has as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (repoPicker.resolve as ReturnType<typeof vi.fn>).mockReturnValue(newDir);

    whatsapp.emit("message", { jid: JID, text: "2", key: "k1" });
    await new Promise((r) => setTimeout(r, 0));

    expect(repoPicker.resolve).toHaveBeenCalledWith(JID, "2");
    expect(sessionRepo.update).toHaveBeenCalledWith(
      JID,
      expect.objectContaining({ engine: "opencode", model: "custom-model", effort: "high", workingDir: newDir }),
    );
    expect(sentTexts.some((t) => t.includes(newDir))).toBe(true);
  });

  describe('pagination ("more") — see session/picker.ts', () => {
    it("picking the more slot on /sessions re-sends the next page instead of switching", async () => {
      const { whatsapp, ptyManager, sessionPicker, sentTexts } = makeBridge();
      (sessionPicker.has as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (sessionPicker.resolve as ReturnType<typeof vi.fn>).mockReturnValue("more");
      (sessionPicker.renderPage as ReturnType<typeof vi.fn>).mockReturnValue("20. ▶ page 2");

      whatsapp.emit("message", { jid: JID, text: "20", key: "k1" });
      await new Promise((r) => setTimeout(r, 0));

      expect(sessionPicker.renderPage).toHaveBeenCalledWith(JID);
      expect(sentTexts).toContain("20. ▶ page 2");
      expect(ptyManager.start).not.toHaveBeenCalled();
    });

    it("picking the more slot on /file re-sends the next page instead of sending a document", async () => {
      const { whatsapp, sender, filePicker, sentTexts } = makeBridge();
      (filePicker.has as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (filePicker.resolve as ReturnType<typeof vi.fn>).mockReturnValue("more");
      (filePicker.renderPage as ReturnType<typeof vi.fn>).mockReturnValue("20. ▶ page 2");

      whatsapp.emit("message", { jid: JID, text: "20", key: "k1" });
      await new Promise((r) => setTimeout(r, 0));

      expect(filePicker.renderPage).toHaveBeenCalledWith(JID);
      expect(sentTexts).toContain("20. ▶ page 2");
      expect(sender.sendDocument).not.toHaveBeenCalled();
    });

    it("picking the more slot on /repo re-sends the next page instead of switching directory", async () => {
      const { whatsapp, sessionRepo, repoPicker, sentTexts } = makeBridge();
      (repoPicker.has as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (repoPicker.resolve as ReturnType<typeof vi.fn>).mockReturnValue("more");
      (repoPicker.renderPage as ReturnType<typeof vi.fn>).mockReturnValue("20. ▶ page 2");
      const updatesBefore = (sessionRepo.update as ReturnType<typeof vi.fn>).mock.calls.length;

      whatsapp.emit("message", { jid: JID, text: "20", key: "k1" });
      await new Promise((r) => setTimeout(r, 0));

      expect(repoPicker.renderPage).toHaveBeenCalledWith(JID);
      expect(sentTexts).toContain("20. ▶ page 2");
      expect((sessionRepo.update as ReturnType<typeof vi.fn>).mock.calls.length).toBe(updatesBefore);
    });
  });

  it("forwards a progress event only when verbose is on for that session", async () => {
    const { whatsapp, ptyManager, sentTexts, sessionRepo } = makeBridge();
    whatsapp.emit("message", { jid: JID, text: "write a report", key: "k1" });
    await new Promise((r) => setTimeout(r, 0));

    ptyManager.emit("progress", JID, "Update(a.ts)");
    await new Promise((r) => setTimeout(r, 0));
    expect(sentTexts).not.toContain("Update(a.ts)");

    sessionRepo.update(JID, { verbose: true });
    ptyManager.emit("progress", JID, "Update(b.ts)");
    await new Promise((r) => setTimeout(r, 0));
    expect(sentTexts.some((text) => text.includes("> (1 command run)"))).toBe(true);
    expect(sentTexts.some((text) => text.includes("Update(b.ts)"))).toBe(false);
  });

  it("compacts italicized tool-call lines (the shape manager.ts actually emits) into a count summary before sending", async () => {
    const { whatsapp, ptyManager, sentTexts, sessionRepo } = makeBridge();
    whatsapp.emit("message", { jid: JID, text: "write a report", key: "k1" });
    await new Promise((r) => setTimeout(r, 0));
    sessionRepo.update(JID, { verbose: true });

    ptyManager.emit("progress", JID, "_Write(a.ts)_\n_Write(b.ts)_");
    await new Promise((r) => setTimeout(r, 0));

    expect(sentTexts.some((t) => t.includes("> (2 commands run)"))).toBe(true);
    expect(sentTexts.some((t) => t.includes("_Write(a.ts)_"))).toBe(false);

    ptyManager.emit("complete", JID, "_Bash(npm test)_\nAll checks passed.");
    await new Promise((r) => setTimeout(r, 0));

    expect(sentTexts.some((t) => t.includes("> (1 command run)\n\nAll checks passed."))).toBe(true);
  });

  describe("incoming images", () => {
    afterEach(() => {
      fs.rmSync(path.join(os.tmpdir(), "whatsapp-bridge-inbox", JID), { recursive: true, force: true });
    });

    it("downloads the image, saves it, and forwards a prompt referencing its path plus the caption", async () => {
      const { whatsapp, ptyManager, sender } = makeBridge();

      whatsapp.emit("message", {
        jid: JID,
        text: "",
        key: "k1",
        image: { mediaId: "media-1", caption: "inspect this chart" },
      });
      await new Promise((r) => setTimeout(r, 0));

      expect(sender.downloadMedia).toHaveBeenCalledWith("media-1");
      const [, , promptText] = ptyManager.start.mock.calls[0]!;
      expect(promptText).toContain("inspect this chart");
      expect(promptText).toMatch(/\[Received image: (.+\.jpe?g)\]/);

      const match = /\[Received image: (.+\.jpe?g)\]/.exec(promptText);
      const savedPath = match![1]!;
      expect(fs.readFileSync(savedPath, "utf8")).toBe("fake-image-bytes");
    });

    it("forwards just the image reference when there's no caption", async () => {
      const { whatsapp, ptyManager } = makeBridge();

      whatsapp.emit("message", { jid: JID, text: "", key: "k1", image: { mediaId: "media-1", caption: null } });
      await new Promise((r) => setTimeout(r, 0));

      const [, , promptText] = ptyManager.start.mock.calls[0]!;
      expect(promptText).toMatch(/^\[Received image: .+\.jpe?g\]$/);
    });

    it("reports an error and never starts a session when the download fails", async () => {
      const { whatsapp, ptyManager, sender, sentTexts } = makeBridge();
      (sender.downloadMedia as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

      whatsapp.emit("message", { jid: JID, text: "", key: "k1", image: { mediaId: "media-1", caption: null } });
      await new Promise((r) => setTimeout(r, 0));

      expect(sentTexts.some((t) => t.includes("Could not download"))).toBe(true);
      expect(ptyManager.start).not.toHaveBeenCalled();
    });
  });

  describe("message queueing while EXECUTING", () => {
    it("queues a message sent while busy instead of writing it into the pty or refusing it", async () => {
      const { whatsapp, ptyManager, reactions, getState } = makeBridge();
      whatsapp.emit("message", { jid: JID, text: "write a report", key: "k1" });
      await new Promise((r) => setTimeout(r, 0));
      expect(getState().state).toBe("EXECUTING");

      whatsapp.emit("message", { jid: JID, text: "also write a summary", key: "k2" });
      await new Promise((r) => setTimeout(r, 0));

      expect(ptyManager.send).not.toHaveBeenCalledWith(JID, "also write a summary");
      expect(reactions).toContainEqual({ emoji: "📥", key: "k2" });
      expect(getState().state).toBe("EXECUTING");
    });

    it("drains the next queued message once the current turn completes, staying in EXECUTING", async () => {
      const { whatsapp, ptyManager, reactions, sentTexts, getState } = makeBridge();
      whatsapp.emit("message", { jid: JID, text: "write a report", key: "k1" });
      await new Promise((r) => setTimeout(r, 0));
      whatsapp.emit("message", { jid: JID, text: "also write a summary", key: "k2" });
      await new Promise((r) => setTimeout(r, 0));

      ptyManager.isAlive.mockReturnValue(true);
      ptyManager.emit("complete", JID, "Report ready.");
      await new Promise((r) => setTimeout(r, 0));

      expect(sentTexts).toContain("Report ready.");
      expect(ptyManager.send).toHaveBeenCalledWith(JID, "also write a summary");
      expect(reactions).toContainEqual({ emoji: "✅", key: "k2" });
      expect(getState().state).toBe("EXECUTING");
    });

    it("processes queued messages one at a time, in order — not concatenated into one", async () => {
      const { whatsapp, ptyManager, getState } = makeBridge();
      whatsapp.emit("message", { jid: JID, text: "first", key: "k1" });
      await new Promise((r) => setTimeout(r, 0));
      whatsapp.emit("message", { jid: JID, text: "second", key: "k2" });
      await new Promise((r) => setTimeout(r, 0));
      whatsapp.emit("message", { jid: JID, text: "third", key: "k3" });
      await new Promise((r) => setTimeout(r, 0));

      ptyManager.isAlive.mockReturnValue(true);
      ptyManager.emit("complete", JID, "First task complete.");
      await new Promise((r) => setTimeout(r, 0));
      expect(ptyManager.send).toHaveBeenCalledWith(JID, "second");
      expect(getState().state).toBe("EXECUTING");

      ptyManager.emit("complete", JID, "Second task complete.");
      await new Promise((r) => setTimeout(r, 0));
      expect(ptyManager.send).toHaveBeenCalledWith(JID, "third");

      ptyManager.emit("complete", JID, "Third task complete.");
      await new Promise((r) => setTimeout(r, 0));
      expect(getState().state).toBe("IDLE");
    });

    it("goes IDLE as usual on complete when nothing is queued", async () => {
      const { whatsapp, ptyManager, getState } = makeBridge();
      whatsapp.emit("message", { jid: JID, text: "write a report", key: "k1" });
      await new Promise((r) => setTimeout(r, 0));

      ptyManager.emit("complete", JID, "Done.");
      await new Promise((r) => setTimeout(r, 0));

      expect(getState().state).toBe("IDLE");
    });

    it("clears the queue if the process exits before it can be drained", async () => {
      const { whatsapp, ptyManager } = makeBridge();
      whatsapp.emit("message", { jid: JID, text: "write a report", key: "k1" });
      await new Promise((r) => setTimeout(r, 0));
      whatsapp.emit("message", { jid: JID, text: "and a summary", key: "k2" });
      await new Promise((r) => setTimeout(r, 0));

      ptyManager.emit("exit", JID, 1);
      await new Promise((r) => setTimeout(r, 0));

      ptyManager.isAlive.mockReturnValue(true);
      ptyManager.emit("complete", JID, "n/a");
      await new Promise((r) => setTimeout(r, 0));
      expect(ptyManager.send).not.toHaveBeenCalledWith(JID, "and a summary");
    });
  });

  it("refuses to switch to a session whose directory no longer exists, without touching the current one", async () => {
    const { whatsapp, ptyManager, sessionPicker, sentTexts, getState } = makeBridge();
    const target: DiscoveredSession = {
      engine: "claude",
      resumeId: "gone-dir-id",
      directory: "/tmp/definitely-does-not-exist-bridge-test-xyz",
      title: "Old worktree",
      updatedAt: Date.now(),
      live: false,
      tmuxSession: "wa-claude-gone-dir-id",
      activeElsewhere: false,
    };
    (sessionPicker.has as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (sessionPicker.resolve as ReturnType<typeof vi.fn>).mockReturnValue(target);

    whatsapp.emit("message", { jid: JID, text: "1", key: "k1" });
    await new Promise((r) => setTimeout(r, 0));

    expect(sentTexts.some((t) => t.includes("Directory not found"))).toBe(true);
    expect(ptyManager.detach).not.toHaveBeenCalled();
    expect(ptyManager.start).not.toHaveBeenCalled();
    expect(getState().workingDir).not.toBe(target.directory);
  });

  it("prevents two chats from attaching to the same live agent session", async () => {
    const resumeId = "shared-session";
    const tmuxSession = `wa-claude-${resumeId}`;
    const owner = fakeSession({ jid: "tg:123", resumeId, tmuxSession });
    const { whatsapp, ptyManager, sessionPicker, sentTexts } = makeBridge([owner]);
    const target: DiscoveredSession = {
      engine: "claude",
      resumeId,
      directory: os.tmpdir(),
      title: "Shared session",
      updatedAt: Date.now(),
      live: true,
      tmuxSession,
      activeElsewhere: false,
    };
    (sessionPicker.has as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (sessionPicker.resolve as ReturnType<typeof vi.fn>).mockReturnValue(target);

    whatsapp.emit("message", { jid: JID, text: "1", key: "k1" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentTexts.some((text) => text.includes("already attached to another chat"))).toBe(true);
    expect(ptyManager.start).not.toHaveBeenCalled();
  });

  describe("arbitration", () => {
    let external: ChildProcess;

    afterEach(() => {
      if (external?.pid && !external.killed) {
        try {
          process.kill(external.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    });

    it("option 2 leaves the external process alone and arms a free watch", async () => {
      const resumeId = "bridge-test-arb-leave-id";
      external = spawn("node", ["-e", "setInterval(() => {}, 1000)", "--", `--resume=${resumeId}`], {
        stdio: "ignore",
      });
      await new Promise((r) => setTimeout(r, 300));

      const { whatsapp, ptyManager, sessionPicker, sentTexts, watchForFree, freeWatches } = makeBridge();
      const target: DiscoveredSession = {
        engine: "claude",
        resumeId,
        directory: os.tmpdir(),
        title: "Session open elsewhere",
        updatedAt: Date.now(),
        live: false,
        tmuxSession: `wa-claude-${resumeId}`,
        activeElsewhere: true,
      };
      (sessionPicker.has as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (sessionPicker.resolve as ReturnType<typeof vi.fn>).mockReturnValue(target);

      whatsapp.emit("message", { jid: JID, text: "1", key: "k1" });
      await new Promise((r) => setTimeout(r, 400));

      whatsapp.emit("message", { jid: JID, text: "2", key: "k2" });
      await new Promise((r) => setTimeout(r, 200));

      expect(sentTexts.some((t) => t.includes("notify me when it is free"))).toBe(true);
      expect(ptyManager.start).not.toHaveBeenCalled();
      expect(() => process.kill(external.pid!, 0)).not.toThrow();
      expect(watchForFree).toHaveBeenCalledWith(JID, expect.objectContaining({ resumeId }));
      expect(freeWatches).toHaveLength(1);
    });

    it("option 3 forks a new branch without touching the external process", async () => {
      const resumeId = "bridge-test-arb-fork-id";
      external = spawn("node", ["-e", "setInterval(() => {}, 1000)", "--", `--resume=${resumeId}`], {
        stdio: "ignore",
      });
      await new Promise((r) => setTimeout(r, 300));

      const { whatsapp, ptyManager, sessionPicker, sentTexts } = makeBridge();
      const target: DiscoveredSession = {
        engine: "claude",
        resumeId,
        directory: os.tmpdir(),
        title: "Session open elsewhere",
        updatedAt: Date.now(),
        live: false,
        tmuxSession: `wa-claude-${resumeId}`,
        activeElsewhere: true,
      };
      (sessionPicker.has as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (sessionPicker.resolve as ReturnType<typeof vi.fn>).mockReturnValue(target);

      whatsapp.emit("message", { jid: JID, text: "1", key: "k1" });
      await new Promise((r) => setTimeout(r, 400));

      whatsapp.emit("message", { jid: JID, text: "3", key: "k2" });
      await new Promise((r) => setTimeout(r, 200));

      expect(ptyManager.start).toHaveBeenCalledWith(JID, expect.objectContaining({ resumeId, fork: true }), null);
      expect(() => process.kill(external.pid!, 0)).not.toThrow();
      expect(sentTexts.some((t) => t.includes("Forked"))).toBe(true);
    });

    it("keeps the arbitration pending on an unrecognized reply instead of dropping it", async () => {
      const resumeId = "bridge-test-arb-invalid-id";
      external = spawn("node", ["-e", "setInterval(() => {}, 1000)", "--", `--resume=${resumeId}`], {
        stdio: "ignore",
      });
      await new Promise((r) => setTimeout(r, 300));

      const { whatsapp, ptyManager, sessionPicker, sentTexts } = makeBridge();
      const target: DiscoveredSession = {
        engine: "claude",
        resumeId,
        directory: os.tmpdir(),
        title: "Session open elsewhere",
        updatedAt: Date.now(),
        live: false,
        tmuxSession: `wa-claude-${resumeId}`,
        activeElsewhere: true,
      };
      (sessionPicker.has as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (sessionPicker.resolve as ReturnType<typeof vi.fn>).mockReturnValue(target);

      whatsapp.emit("message", { jid: JID, text: "1", key: "k1" });
      await new Promise((r) => setTimeout(r, 400));

      whatsapp.emit("message", { jid: JID, text: "banane", key: "k2" });
      await new Promise((r) => setTimeout(r, 100));
      expect(sentTexts.some((t) => t.includes("Reply 1, 2, or 3"))).toBe(true);
      expect(ptyManager.start).not.toHaveBeenCalled();

      whatsapp.emit("message", { jid: JID, text: "3", key: "k3" });
      await new Promise((r) => setTimeout(r, 200));
      expect(ptyManager.start).toHaveBeenCalled();
    });

    it("Mac-initiated: presentArbitration raises the same card, and option 2 kills the WhatsApp side (yields) instead of arming a free watch", async () => {
      const { bridge, whatsapp, ptyManager, sentTexts, watchForFree } = makeBridge();
      const target = {
        engine: "claude" as const,
        resumeId: "mac-initiated-id",
        directory: "/tmp",
        tmuxSession: "wa-claude-mac-initiated-id",
        title: "Fix footer",
        live: true,
      };

      await bridge.presentArbitration(JID, target, [4242], "mac");
      expect(sentTexts.some((t) => t.includes("Take control here"))).toBe(true);

      whatsapp.emit("message", { jid: JID, text: "2", key: "k1" });
      await new Promise((r) => setTimeout(r, 100));

      expect(ptyManager.kill).toHaveBeenCalledWith(JID);
      expect(watchForFree).not.toHaveBeenCalled();
    });

    it("Mac-initiated, option 1: closes the Mac's process and keeps WhatsApp's own session untouched", async () => {
      const resumeId = "mac-initiated-id-2";
      external = spawn("node", ["-e", "setInterval(() => {}, 1000)", "--", `--resume=${resumeId}`], {
        stdio: "ignore",
      });
      await new Promise((r) => setTimeout(r, 300));

      const { bridge, whatsapp, ptyManager, sentTexts } = makeBridge();
      const target = {
        engine: "claude" as const,
        resumeId,
        directory: "/tmp",
        tmuxSession: `wa-claude-${resumeId}`,
        title: "Fix footer",
        live: true,
      };

      await bridge.presentArbitration(JID, target, [external.pid!], "mac");
      whatsapp.emit("message", { jid: JID, text: "1", key: "k1" });
      await new Promise((r) => setTimeout(r, 400));

      expect(sentTexts.some((t) => t.includes("Closed 1 external process"))).toBe(true);
      expect(ptyManager.kill).not.toHaveBeenCalled();
      expect(ptyManager.start).not.toHaveBeenCalled();
      expect(() => process.kill(external.pid!, 0)).toThrow();
    });

    it("resolveArbitration re-checks freshness instead of trusting a stale pid list: an external process that already exited by resolve time is reported as already-gone, not killed blind", async () => {
      const resumeId = "mac-initiated-already-exited-id";
      const { bridge, whatsapp, ptyManager, sentTexts } = makeBridge();
      const target = {
        engine: "claude" as const,
        resumeId,
        directory: "/tmp",
        tmuxSession: `wa-claude-${resumeId}`,
        title: "Fix footer",
        live: true,
      };

      await bridge.presentArbitration(JID, target, [999999], "mac");
      whatsapp.emit("message", { jid: JID, text: "1", key: "k1" });
      await new Promise((r) => setTimeout(r, 400));

      expect(sentTexts.some((t) => t.includes("Closed 0 external process"))).toBe(true);
      expect(ptyManager.kill).not.toHaveBeenCalled();
    });

    it("Mac-initiated presentArbitration queues behind an in-flight handleIncoming for the same jid instead of racing it", async () => {
      const { bridge, whatsapp, sender, sentTexts } = makeBridge();

      let releaseReact: () => void = () => {};
      const blocked = new Promise<void>((resolve) => {
        releaseReact = resolve;
      });
      (sender.react as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
        await blocked;
      });

      whatsapp.emit("message", { jid: JID, text: "write a report", key: "k1" });
      await new Promise((r) => setTimeout(r, 0));

      const target = {
        engine: "claude" as const,
        resumeId: "race-id",
        directory: "/tmp",
        tmuxSession: "wa-claude-race-id",
        title: "Race test",
        live: true,
      };
      const arbitrationDone = bridge.presentArbitration(JID, target, [], "mac");
      await new Promise((r) => setTimeout(r, 50));

      expect(sentTexts.some((t) => t.includes("Take control here"))).toBe(false);

      releaseReact();
      await arbitrationDone;

      expect(sentTexts.some((t) => t.includes("Take control here"))).toBe(true);
    });
  });

  describe("takeover — switching to a session that's open elsewhere", () => {
    let external: ChildProcess;

    afterEach(() => {
      if (external?.pid && !external.killed) {
        try {
          process.kill(external.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    });

    it("closes a real external process holding the same resume id, and says so", async () => {
      const resumeId = "bridge-test-takeover-id-9f31";
      external = spawn("node", ["-e", "setInterval(() => {}, 1000)", "--", `--resume=${resumeId}`], {
        stdio: "ignore",
      });
      await new Promise((r) => setTimeout(r, 300));

      const { whatsapp, sessionPicker, sentTexts } = makeBridge();
      const target: DiscoveredSession = {
        engine: "claude",
        resumeId,
        directory: os.tmpdir(),
        title: "Session open elsewhere",
        updatedAt: Date.now(),
        live: false,
        tmuxSession: `wa-claude-${resumeId}`,
        activeElsewhere: true,
      };
      (sessionPicker.has as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (sessionPicker.resolve as ReturnType<typeof vi.fn>).mockReturnValue(target);

      whatsapp.emit("message", { jid: JID, text: "1", key: "k1" });
      await new Promise((r) => setTimeout(r, 400));

      expect(sentTexts.some((t) => t.includes("Take control here"))).toBe(true);
      expect(() => process.kill(external.pid!, 0)).not.toThrow();

      whatsapp.emit("message", { jid: JID, text: "1", key: "k2" });
      await new Promise((r) => setTimeout(r, 400));

      expect(sentTexts.some((t) => t.includes("Closed 1 external process"))).toBe(true);

      expect(() => process.kill(external.pid!, 0)).toThrow();
    });
  });
});
