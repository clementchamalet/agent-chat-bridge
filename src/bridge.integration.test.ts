import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Bridge } from "./bridge.js";
import { openDatabase } from "./db/database.js";
import { SessionRepository } from "./db/sessions.js";
import type { DiscoveredSession } from "./discovery/sessions.js";
import { PtyManager } from "./pty/manager.js";
import { Picker } from "./session/picker.js";
import { makeLogger } from "./utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JID = "bridge-integration-test-jid";

function killTmux(name: string): void {
  try {
    execFileSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" });
  } catch {
    // already gone
  }
}

describe("Bridge + real PtyManager — reattach then immediate switch", () => {
  let binDir: string;
  let originalPath: string;
  let dbDir: string;
  let survivedSession: string;
  let switchTargetSession: string;

  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-integration-bin-"));
    const fixture = path.join(__dirname, "pty", "__fixtures__", "reattach-idle-agent.mjs");
    const claudeShim = path.join(binDir, "claude");
    fs.copyFileSync(fixture, claudeShim);
    fs.chmodSync(claudeShim, 0o755);

    originalPath = process.env.PATH ?? "";
    process.env.PATH = `${binDir}:${originalPath}`;

    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-integration-db-"));

    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    survivedSession = `wa-claude-integration-survived-${unique}`;
    switchTargetSession = `wa-claude-integration-target-${unique}`;

    execFileSync("tmux", [
      "-u",
      "new-session",
      "-d",
      "-s",
      survivedSession,
      "-x",
      "80",
      "-y",
      "24",
      "--",
      "node",
      fixture,
    ]);
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
    killTmux(survivedSession);
    killTmux(switchTargetSession);
  });

  it("delivers the message that relaunches a survived session, then switches to another live session without losing the message or throwing", async () => {
    const dbPath = path.join(dbDir, "bridge.sqlite3");
    const sessionRepo = new SessionRepository(openDatabase(dbPath));
    const ptyManager = new PtyManager(makeLogger("error", "test"), 200);
    const whatsapp = new EventEmitter();
    const sentTexts: string[] = [];
    const sender = {
      sendText: async (_jid: string, text: string) => {
        sentTexts.push(text);
        return "msg-id";
      },
      react: async () => {},
      sendDocument: async () => {},
      downloadMedia: async () => null,
    };
    const sessionPicker = new Picker<DiscoveredSession>();
    const filePicker = new Picker<string>();
    const repoPicker = new Picker<string>();

    const bridge = new Bridge({
      source: whatsapp as never,
      ptyManager,
      sessionRepo,
      sender: sender as never,
      sessionPicker,
      filePicker,
      repoPicker,
      logger: makeLogger("error", "test"),
      watchForFree: () => {},
    });
    bridge.wire();

    sessionRepo.getOrCreate(JID);
    sessionRepo.update(JID, {
      engine: "claude",
      workingDir: process.cwd(),
      tmuxSession: survivedSession,
      state: "IDLE",
      ptyPid: null,
    });

    whatsapp.emit("message", { jid: JID, text: "continue the refactor", key: "k1" });

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !sentTexts.some((t) => t.includes("got: continue the refactor"))) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(sentTexts.some((t) => t.includes("got: continue the refactor"))).toBe(true);
    expect(sessionRepo.get(JID)?.state).toBe("IDLE");

    expect(ptyManager.isAlive(JID)).toBe(true);

    const target: DiscoveredSession = {
      engine: "claude",
      resumeId: "integration-switch-target-id",
      directory: process.cwd(),
      title: "Another session",
      updatedAt: Date.now(),
      live: false,
      tmuxSession: switchTargetSession,
      activeElsewhere: false,
    };
    sessionPicker.show(JID, [target], (page) =>
      page.items.map((s, i) => `${page.startNumber + i}. ${s.title}`).join("\n"),
    );

    whatsapp.emit("message", { jid: JID, text: "1", key: "k2" });
    await new Promise((r) => setTimeout(r, 800));

    expect(sessionRepo.get(JID)?.tmuxSession).toBe(switchTargetSession);
    expect(ptyManager.isAlive(JID)).toBe(true);

    ptyManager.kill(JID, "SIGKILL");
  }, 20_000);

  it("delivers the existing reply and queued input in order after reattaching", async () => {
    const fixture = path.join(__dirname, "pty", "__fixtures__", "reattach-unreported-reply-agent.mjs");
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const unreportedSession = `wa-claude-integration-unreported-${unique}`;
    execFileSync("tmux", ["-u", "new-session", "-d", "-s", unreportedSession, "--", "node", fixture]);

    try {
      const dbPath = path.join(dbDir, "bridge2.sqlite3");
      const sessionRepo = new SessionRepository(openDatabase(dbPath));
      const ptyManager = new PtyManager(makeLogger("error", "test"), 200);
      const whatsapp = new EventEmitter();
      const sentTexts: string[] = [];
      const sender = {
        sendText: async (_jid: string, text: string) => {
          sentTexts.push(text);
          return "msg-id";
        },
        react: async () => {},
        sendDocument: async () => {},
        downloadMedia: async () => null,
      };

      const bridge = new Bridge({
        source: whatsapp as never,
        ptyManager,
        sessionRepo,
        sender: sender as never,
        sessionPicker: new Picker<DiscoveredSession>(),
        filePicker: new Picker<string>(),
        repoPicker: new Picker<string>(),
        logger: makeLogger("error", "test"),
        watchForFree: () => {},
      });
      bridge.wire();

      sessionRepo.getOrCreate(JID);
      sessionRepo.update(JID, {
        engine: "claude",
        workingDir: process.cwd(),
        tmuxSession: unreportedSession,
        state: "IDLE",
        ptyPid: null,
      });

      whatsapp.emit("message", { jid: JID, text: "first message", key: "k1" });
      whatsapp.emit("message", { jid: JID, text: "second message", key: "k2" });

      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && !sentTexts.some((t) => t.includes("got: second message"))) {
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(sentTexts.length).toBeGreaterThanOrEqual(3);
      expect(sentTexts[0]).toContain("ALREADY_FINISHED_REPLY_BEFORE_RESTART");
      const firstIdx = sentTexts.findIndex((t) => t.includes("got: first message"));
      const secondIdx = sentTexts.findIndex((t) => t.includes("got: second message"));
      expect(firstIdx).toBeGreaterThan(0);
      expect(secondIdx).toBeGreaterThan(firstIdx);
      expect(sessionRepo.get(JID)?.state).toBe("IDLE");

      ptyManager.kill(JID, "SIGKILL");
    } finally {
      killTmux(unreportedSession);
    }
  }, 20_000);
});
