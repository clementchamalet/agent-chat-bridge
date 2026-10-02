import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootstrapIdentity,
  capturePane,
  isBridgeSessionName,
  liveSessionName,
  placeholderSessionName,
  sanitizeSessionLabel,
} from "./tmux.js";

describe("sanitizeSessionLabel", () => {
  it("strips characters unsafe for a tmux session name", () => {
    expect(sanitizeSessionLabel("ses_01e3c43e:foo/bar baz")).toBe("ses_01e3c43efoobarbaz");
  });
});

describe("liveSessionName", () => {
  it("is deterministic for the same engine + resumeId", () => {
    expect(liveSessionName("claude", "1eda0a3d-ab74")).toBe(liveSessionName("claude", "1eda0a3d-ab74"));
  });

  it("differs across engines for the same id", () => {
    expect(liveSessionName("claude", "abc")).not.toBe(liveSessionName("opencode", "abc"));
  });

  it("is a bridge session name", () => {
    expect(isBridgeSessionName(liveSessionName("claude", "abc"))).toBe(true);
  });
});

describe("placeholderSessionName", () => {
  it("is unique across calls, even for the same engine and jid", () => {
    expect(placeholderSessionName("opencode", "33612345678")).not.toBe(
      placeholderSessionName("opencode", "33612345678"),
    );
  });

  it("is a bridge session name", () => {
    expect(isBridgeSessionName(placeholderSessionName("opencode", "33612345678"))).toBe(true);
  });
});

describe("isBridgeSessionName", () => {
  it("rejects session names the bridge didn't create", () => {
    expect(isBridgeSessionName("some-unrelated-session")).toBe(false);
  });
});

describe("bootstrapIdentity", () => {
  it("mints a real resumeId for claude, with the tmux name derived from it — a single naming form, known immediately", () => {
    const identity = bootstrapIdentity("claude", "33612345678");
    expect(identity.resumeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(identity.tmuxSession).toBe(liveSessionName("claude", identity.resumeId!));
  });

  it("mints a fresh id on every call", () => {
    expect(bootstrapIdentity("claude", "33612345678").resumeId).not.toBe(
      bootstrapIdentity("claude", "33612345678").resumeId,
    );
  });

  it("leaves resumeId null for opencode — no way to choose an id up front — with a placeholder tmux name", () => {
    const identity = bootstrapIdentity("opencode", "33612345678");
    expect(identity.resumeId).toBeNull();
    expect(isBridgeSessionName(identity.tmuxSession)).toBe(true);
  });
});

describe("capturePane", () => {
  const SESSION = "wa-claude-tmux-test-screen";

  afterEach(() => {
    try {
      execFileSync("tmux", ["kill-session", "-t", SESSION], { stdio: "ignore" });
    } catch {
      // already gone
    }
  });

  it("returns the real pane content for a live tmux session", async () => {
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
      "process.stdout.write('hello from screen test'); setInterval(() => {}, 1000)",
    ]);
    await new Promise((r) => setTimeout(r, 500));

    expect(capturePane(SESSION)).toContain("hello from screen test");
  });

  it("returns null for a session that doesn't exist", () => {
    expect(capturePane("wa-claude-no-such-session-at-all")).toBeNull();
  });
});
