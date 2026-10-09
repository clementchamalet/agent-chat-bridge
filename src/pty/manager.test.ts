import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../config.js";
import { makeLogger } from "../utils/logger.js";
import { computeProgressIncrement, PtyManager } from "./manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("computeProgressIncrement", () => {
  it("sends just the appended part when body still starts with what was already reported", () => {
    expect(computeProgressIncrement("A\nB\nC", "A\nB\nC\nD")).toBe("D");
  });

  it("finds the resume point by overlap when the fixed-height viewport scrolled older lines off the top", () => {
    const previous = "Step one is complete.\nStep two is complete.\nStep three is complete.";
    const body = "Step two is complete.\nStep three is complete.\nStep four is complete.";

    expect(computeProgressIncrement(previous, body)).toBe("Step four is complete.");
  });

  it("falls back to the whole body when there's no real overlap (nothing to resume from)", () => {
    expect(computeProgressIncrement("completely unrelated old content", "brand new content")).toBe("brand new content");
  });

  it("reports nothing new when body is unchanged", () => {
    expect(computeProgressIncrement("same", "same")).toBe("");
  });
});

describe("PtyManager boot-stability handling", () => {
  let binDir: string;
  let originalPath: string;

  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "pty-manager-test-bin-"));
    const fixture = path.join(__dirname, "__fixtures__", "noisy-boot-agent.mjs");
    const claudeShim = path.join(binDir, "claude");
    fs.copyFileSync(fixture, claudeShim);
    fs.chmodSync(claudeShim, 0o755);

    originalPath = process.env.PATH ?? "";
    process.env.PATH = `${binDir}:${originalPath}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  it("waits for the splash screen to stop repainting before typing the queued prompt, instead of typing into dead air", async () => {
    const manager = new PtyManager(makeLogger("error", "test"), 200);
    const jid = "boot-test-jid";

    const completeEvent = new Promise<string>((resolve) => {
      manager.on("complete", (_jid, text) => resolve(text));
    });

    manager.start(
      jid,
      { engine: "claude", model: null, cwd: process.cwd(), sessionName: jid },
      "hello from the bridge",
    );

    const finalFrame = await completeEvent;

    expect(finalFrame).toContain("got: hello from the bridge");
    expect(finalFrame).toContain("DONE_MARKER");

    manager.kill(jid, "SIGKILL");
  }, 10_000);

  it("reports the already-settled screen even with no initial prompt to write (a bare /sessions attach)", async () => {
    const manager = new PtyManager(makeLogger("error", "test"), 200);
    const jid = "bare-attach-test-jid";

    const completeEvent = new Promise<string>((resolve) => {
      manager.on("complete", (_jid, text) => resolve(text));
    });

    manager.start(jid, { engine: "claude", model: null, cwd: process.cwd(), sessionName: jid }, null);

    const finalFrame = await completeEvent;
    expect(finalFrame).toBeTruthy();

    manager.kill(jid, "SIGKILL");
  }, 10_000);

  it("emits exactly one event per turn even when the effort footer renders in a separate repaint", async () => {
    const fixture = path.join(__dirname, "__fixtures__", "flaky-footer-agent.mjs");
    const claudeShim = path.join(binDir, "claude");
    fs.copyFileSync(fixture, claudeShim);
    fs.chmodSync(claudeShim, 0o755);

    const manager = new PtyManager(makeLogger("error", "test"), 100);
    const jid = "flaky-footer-test-jid";

    const events: { kind: string; text: string }[] = [];
    manager.on("complete", (_jid, text) => events.push({ kind: "complete", text }));
    manager.on("question", (_jid, text) => events.push({ kind: "question", text }));

    manager.start(jid, { engine: "claude", model: null, cwd: process.cwd(), sessionName: jid }, "hello");

    await new Promise((r) => setTimeout(r, 4000));

    expect(events).toHaveLength(1);
    expect(events[0]!.text).toContain("high");
    expect(events[0]!.text).toContain("Hey! What are you working on today?");

    manager.kill(jid, "SIGKILL");
  }, 10_000);

  it("emits incremental progress events while a long turn is still busy, then a single final complete event", async () => {
    const fixture = path.join(__dirname, "__fixtures__", "progress-agent.mjs");
    const claudeShim = path.join(binDir, "claude");
    fs.copyFileSync(fixture, claudeShim);
    fs.chmodSync(claudeShim, 0o755);

    const manager = new PtyManager(makeLogger("error", "test"), 100);
    const jid = "progress-test-jid";

    const events: { kind: string; text: string }[] = [];
    manager.on("progress", (_jid, text) => events.push({ kind: "progress", text }));
    manager.on("complete", (_jid, text) => events.push({ kind: "complete", text }));
    manager.on("question", (_jid, text) => events.push({ kind: "question", text }));

    manager.start(jid, { engine: "claude", model: null, cwd: process.cwd(), sessionName: jid }, "go");

    await new Promise((r) => setTimeout(r, 4500));

    const progress = events.filter((e) => e.kind === "progress");
    const complete = events.filter((e) => e.kind === "complete");

    expect(progress).toHaveLength(2);
    expect(progress[0]!.text).toContain("Update(a.ts)");
    expect(progress[0]!.text).toMatch(/_\d+s_$/);
    expect(progress[1]!.text).not.toContain("Update(a.ts)");
    expect(progress[1]!.text).toContain("Update(b.ts)");
    expect(progress[1]!.text).toMatch(/_\d+s_$/);

    expect(complete).toHaveLength(1);
    expect(complete[0]!.text).toContain("All done.");

    manager.kill(jid, "SIGKILL");
  }, 10_000);

  it("still emits a progress ping during a turn that never leaves an idle gap, via the independent progressTimer poll", async () => {
    const fixture = path.join(__dirname, "__fixtures__", "continuous-repaint-agent.mjs");
    const claudeShim = path.join(binDir, "claude");
    fs.copyFileSync(fixture, claudeShim);
    fs.chmodSync(claudeShim, 0o755);

    const manager = new PtyManager(makeLogger("error", "test"), 1000, 300);
    const jid = "continuous-repaint-test-jid";

    const events: { kind: string; text: string }[] = [];
    manager.on("progress", (_jid, text) => events.push({ kind: "progress", text }));

    manager.start(jid, { engine: "claude", model: null, cwd: process.cwd(), sessionName: jid }, "go");

    const deadline = Date.now() + 14_000;
    while (Date.now() < deadline && !events.some((e) => e.kind === "progress" && e.text.includes("Update(a.ts)"))) {
      await new Promise((r) => setTimeout(r, 250));
    }

    const progress = events.filter((e) => e.kind === "progress");
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.some((e) => e.text.includes("Update(a.ts)"))).toBe(true);

    manager.kill(jid, "SIGKILL");
  }, 20_000);

  it("detects progress/complete quickly when re-attaching to a tmux session that's already mid-task, instead of waiting through the fresh-spawn boot dance", async () => {
    const fixture = path.join(__dirname, "__fixtures__", "already-running-agent.mjs");
    const sessionName = "already-running-test-jid";

    execFileSync("tmux", ["-u", "new-session", "-d", "-s", sessionName, "--", "node", fixture]);

    try {
      const manager = new PtyManager(makeLogger("error", "test"), 100);
      const jid = sessionName;

      const events: { kind: string; text: string }[] = [];
      manager.on("progress", (_jid, text) => events.push({ kind: "progress", text }));
      manager.on("complete", (_jid, text) => events.push({ kind: "complete", text }));

      await new Promise((r) => setTimeout(r, 300));

      manager.start(jid, { engine: "claude", model: null, cwd: process.cwd(), sessionName }, null);

      await new Promise((r) => setTimeout(r, 1500));

      expect(events.some((e) => e.kind === "progress")).toBe(true);

      manager.kill(jid, "SIGKILL");
    } finally {
      try {
        execFileSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
      } catch {
        // already gone
      }
    }
  }, 10_000);

  it("reports a reply that already finished before a reattach, instead of silently overwriting it with a queued message", async () => {
    const fixture = path.join(__dirname, "__fixtures__", "reattach-unreported-reply-agent.mjs");
    const sessionName = "reattach-unreported-reply-test-jid";

    execFileSync("tmux", ["-u", "new-session", "-d", "-s", sessionName, "--", "node", fixture]);

    try {
      const manager = new PtyManager(makeLogger("error", "test"), 100);
      const jid = sessionName;

      const events: { kind: string; text: string }[] = [];
      manager.on("catchup", (_jid, text) => events.push({ kind: "catchup", text }));
      manager.on("complete", (_jid, text) => events.push({ kind: "complete", text }));

      await new Promise((r) => setTimeout(r, 300));

      manager.start(jid, { engine: "claude", model: null, cwd: process.cwd(), sessionName }, "new message");

      await new Promise((r) => setTimeout(r, 1500));

      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0]).toEqual(expect.objectContaining({ kind: "catchup" }));
      expect(events[0]!.text).toContain("ALREADY_FINISHED_REPLY_BEFORE_RESTART");
      expect(events.some((e) => e.kind === "complete" && e.text.includes("got: new message"))).toBe(true);

      manager.kill(jid, "SIGKILL");
    } finally {
      try {
        execFileSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
      } catch {
        // already gone
      }
    }
  }, 10_000);

  it("emits a second complete event even when two turns render byte-identical final text", async () => {
    const fixture = path.join(__dirname, "__fixtures__", "repeated-reply-agent.mjs");
    const claudeShim = path.join(binDir, "claude");
    fs.copyFileSync(fixture, claudeShim);
    fs.chmodSync(claudeShim, 0o755);

    const manager = new PtyManager(makeLogger("error", "test"), 100);
    const jid = "repeated-reply-test-jid";

    const completions: string[] = [];
    manager.on("complete", (_jid, text) => completions.push(text));

    manager.start(jid, { engine: "claude", model: null, cwd: process.cwd(), sessionName: jid }, "first");
    await new Promise((r) => setTimeout(r, 3000));
    expect(completions).toHaveLength(1);

    manager.send(jid, "second");
    await new Promise((r) => setTimeout(r, 500));

    expect(completions).toHaveLength(2);
    expect(completions[1]).toBe(completions[0]);

    manager.kill(jid, "SIGKILL");
  }, 10_000);

  it("never types a queued prompt into a settled menu/trust dialog — surfaces it as a question and keeps the prompt queued", async () => {
    const fixture = path.join(__dirname, "__fixtures__", "trust-dialog-agent.mjs");
    const claudeShim = path.join(binDir, "claude");
    fs.copyFileSync(fixture, claudeShim);
    fs.chmodSync(claudeShim, 0o755);

    const manager = new PtyManager(makeLogger("error", "test"), 200);
    const jid = "trust-dialog-test-jid";

    const questions: string[] = [];
    manager.on("question", (_jid, text) => questions.push(text));

    manager.start(jid, { engine: "claude", model: null, cwd: process.cwd(), sessionName: jid }, "do the refactor");

    await new Promise((r) => setTimeout(r, 3000));

    expect(questions.some((q) => /trust/i.test(q))).toBe(true);
    expect(manager.cancelPendingInitial(jid)).toBe(true);

    manager.kill(jid, "SIGKILL");
  }, 10_000);

  it("delivers the queued prompt once the dialog is answered", async () => {
    const fixture = path.join(__dirname, "__fixtures__", "trust-dialog-agent.mjs");
    const claudeShim = path.join(binDir, "claude");
    fs.copyFileSync(fixture, claudeShim);
    fs.chmodSync(claudeShim, 0o755);

    const manager = new PtyManager(makeLogger("error", "test"), 200);
    const jid = "trust-dialog-answered-test-jid";

    const events: { kind: string; text: string }[] = [];
    manager.on("question", (_jid, text) => events.push({ kind: "question", text }));
    manager.on("complete", (_jid, text) => events.push({ kind: "complete", text }));

    manager.start(jid, { engine: "claude", model: null, cwd: process.cwd(), sessionName: jid }, "do the refactor");
    await new Promise((r) => setTimeout(r, 3000));
    expect(events.some((e) => e.kind === "question")).toBe(true);

    manager.send(jid, "1");
    await new Promise((r) => setTimeout(r, 2000));

    expect(events.some((e) => e.kind === "complete" && e.text.includes("RECEIVED: do the refactor"))).toBe(true);

    manager.kill(jid, "SIGKILL");
  }, 10_000);

  it("accepts the trust dialog and delivers the queued prompt", async () => {
    const previousMode = config.permissionMode;
    config.permissionMode = "auto";
    const fixture = path.join(__dirname, "__fixtures__", "real-trust-dialog-agent.mjs");
    const claudeShim = path.join(binDir, "claude");
    fs.copyFileSync(fixture, claudeShim);
    fs.chmodSync(claudeShim, 0o755);

    const manager = new PtyManager(makeLogger("error", "test"), 200);
    const jid = "real-trust-dialog-test-jid";

    const events: { kind: string; text: string }[] = [];
    manager.on("question", (_jid, text) => events.push({ kind: "question", text }));
    manager.on("complete", (_jid, text) => events.push({ kind: "complete", text }));
    manager.on("exit", () => events.push({ kind: "exit", text: "" }));

    try {
      manager.start(jid, { engine: "claude", model: null, cwd: process.cwd(), sessionName: jid }, "do the refactor");
      await new Promise((r) => setTimeout(r, 4500));

      expect(events.filter((e) => e.kind === "question" || e.kind === "exit")).toHaveLength(0);
      expect(events.some((e) => e.kind === "complete" && e.text.includes("RECEIVED: do the refactor"))).toBe(true);
    } finally {
      manager.kill(jid, "SIGKILL");
      config.permissionMode = previousMode;
    }
  }, 10_000);

  it("sendMenuChoice navigates a real Ink-style menu with actual arrow-key presses instead of typing the choice as text", async () => {
    const fixture = path.join(__dirname, "__fixtures__", "menu-agent.mjs");
    const claudeShim = path.join(binDir, "claude");
    fs.copyFileSync(fixture, claudeShim);
    fs.chmodSync(claudeShim, 0o755);

    const manager = new PtyManager(makeLogger("error", "test"), 200);
    const jid = "menu-choice-test-jid";

    const events: { kind: string; text: string }[] = [];
    manager.on("question", (_jid, text) => events.push({ kind: "question", text }));
    manager.on("complete", (_jid, text) => events.push({ kind: "complete", text }));

    manager.start(jid, { engine: "claude", model: null, cwd: process.cwd(), sessionName: jid }, null);
    await new Promise((r) => setTimeout(r, 3000));
    expect(events.some((e) => e.kind === "question")).toBe(true);

    expect(manager.getPendingMenu(jid)).toEqual({ cursorIndex: 0, count: 2 });
    expect(manager.sendMenuChoice(jid, 2)).toBe(true);
    await new Promise((r) => setTimeout(r, 1000));

    expect(events.some((e) => e.kind === "complete" && e.text.includes("CONFIRMED: Resume full session as-is"))).toBe(
      true,
    );

    manager.kill(jid, "SIGKILL");
  }, 10_000);

  it("submits the initial prompt with a separately-arriving Enter, not bundled in the same write", async () => {
    const fixture = path.join(__dirname, "__fixtures__", "submit-race-agent.mjs");
    const claudeShim = path.join(binDir, "claude");
    fs.copyFileSync(fixture, claudeShim);
    fs.chmodSync(claudeShim, 0o755);

    const manager = new PtyManager(makeLogger("error", "test"), 200);
    const jid = "submit-race-test-jid";

    const completeEvent = new Promise<string>((resolve) => {
      manager.on("complete", (_jid, text) => resolve(text));
    });

    manager.start(
      jid,
      { engine: "claude", model: null, cwd: process.cwd(), sessionName: jid },
      "hello from the bridge",
    );

    const finalFrame = await completeEvent;
    expect(finalFrame).toContain("got: hello from the bridge");
    expect(finalFrame).toContain("DONE_MARKER");

    manager.kill(jid, "SIGKILL");
  }, 10_000);

  it("captures the model name even when re-attaching to an existing tmux session", async () => {
    const fixture = path.join(__dirname, "__fixtures__", "reattach-with-banner-agent.mjs");
    const sessionName = "reattach-model-name-test-jid";

    execFileSync("tmux", ["-u", "new-session", "-d", "-s", sessionName, "--", "node", fixture]);

    try {
      const manager = new PtyManager(makeLogger("error", "test"), 100);
      const jid = sessionName;

      const events: { kind: string; text: string }[] = [];
      manager.on("complete", (_jid, text) => events.push({ kind: "complete", text }));

      await new Promise((r) => setTimeout(r, 300));

      manager.start(jid, { engine: "claude", model: null, cwd: process.cwd(), sessionName }, null);
      await new Promise((r) => setTimeout(r, 500));

      manager.send(jid, "go");
      await new Promise((r) => setTimeout(r, 500));

      expect(events.some((e) => e.kind === "complete" && e.text.includes("Sonnet 5"))).toBe(true);

      manager.kill(jid, "SIGKILL");
    } finally {
      try {
        execFileSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
      } catch {
        // already gone
      }
    }
  }, 10_000);

  it("seeds the model name from StartOptions.knownModelName when the boot banner is nowhere on screen to scrape", async () => {
    const fixture = path.join(__dirname, "__fixtures__", "reattach-idle-agent.mjs");
    const sessionName = "reattach-known-model-name-test-jid";

    execFileSync("tmux", ["-u", "new-session", "-d", "-s", sessionName, "--", "node", fixture]);

    try {
      const manager = new PtyManager(makeLogger("error", "test"), 100);
      const jid = sessionName;
      const modelResolvedEvents: string[] = [];
      manager.on("modelResolved", (_jid, name) => modelResolvedEvents.push(name));

      const completeEvent = new Promise<string>((resolve) => {
        manager.on("complete", (_jid, text) => resolve(text));
      });

      await new Promise((r) => setTimeout(r, 300));

      manager.start(
        jid,
        { engine: "claude", model: null, cwd: process.cwd(), sessionName, knownModelName: "Sonnet 5" },
        "go",
      );

      const text = await completeEvent;
      expect(text).toContain("Sonnet 5");
      expect(modelResolvedEvents).toEqual([]);

      manager.kill(jid, "SIGKILL");
    } finally {
      try {
        execFileSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
      } catch {
        // already gone
      }
    }
  }, 10_000);

  it("detach() ends the bridge connection without emitting a false exit", async () => {
    const fixture = path.join(__dirname, "__fixtures__", "repeated-reply-agent.mjs");
    const claudeShim = path.join(binDir, "claude");
    fs.copyFileSync(fixture, claudeShim);
    fs.chmodSync(claudeShim, 0o755);

    const manager = new PtyManager(makeLogger("error", "test"), 200);
    const jid = "detach-no-exit-test-jid";

    const exitEvents: number[] = [];
    manager.on("exit", (_jid, code) => exitEvents.push(code));
    const completeEvent = new Promise<void>((resolve) => {
      manager.on("complete", () => resolve());
    });

    manager.start(jid, { engine: "claude", model: null, cwd: process.cwd(), sessionName: jid }, null);
    await completeEvent;

    const detached = await manager.detach(jid);

    expect(detached).toBe(true);
    expect(exitEvents).toEqual([]);
    expect(manager.isAlive(jid)).toBe(false);

    try {
      execFileSync("tmux", ["kill-session", "-t", jid], { stdio: "ignore" });
    } catch {
      // already gone
    }
  }, 10_000);

  it("observes OpenCode turns and tool calls through the PTY", async () => {
    const fixture = path.join(__dirname, "__fixtures__", "opencode-agent.mjs");
    const opencodeShim = path.join(binDir, "opencode");
    fs.copyFileSync(fixture, opencodeShim);
    fs.chmodSync(opencodeShim, 0o755);

    const manager = new PtyManager(makeLogger("error", "test"), 200);
    const jid = "opencode-e2e-test-jid";

    const events: { kind: string; text: string }[] = [];
    manager.on("progress", (_jid, text) => events.push({ kind: "progress", text }));
    manager.on("complete", (_jid, text) => events.push({ kind: "complete", text }));
    manager.on("question", (_jid, text) => events.push({ kind: "question", text }));

    manager.start(jid, { engine: "opencode", model: null, cwd: process.cwd(), sessionName: jid }, "hello opencode");
    await new Promise((r) => setTimeout(r, 6000));

    expect(events.some((e) => e.kind === "progress")).toBe(true);

    const firstComplete = events.find((e) => e.kind === "complete");
    expect(firstComplete?.text).toContain("Reply to: hello opencode");
    expect(firstComplete?.text).not.toContain("┃");
    expect(firstComplete?.text).toContain("DeepSeek V4 Pro · 1.2s");

    events.length = 0;
    manager.send(jid, "please use a tool now");
    await new Promise((r) => setTimeout(r, 2200));

    const secondComplete = events.find((e) => e.kind === "complete");
    expect(secondComplete?.text).toContain("_Write(reply.txt)_");
    expect(secondComplete?.text).toContain("Wrote it.");
    expect(secondComplete?.text).not.toContain("Reply to: hello opencode");
    expect(secondComplete?.text).not.toContain("please use a tool now");

    manager.kill(jid, "SIGKILL");
  }, 15_000);
});
