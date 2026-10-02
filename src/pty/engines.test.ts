import { describe, expect, it } from "vitest";
import { config } from "../config.js";
import { buildSpawnArgs } from "./engines.js";

describe("buildSpawnArgs", () => {
  it("omits the resume flag by default", () => {
    expect(buildSpawnArgs("claude", null)).toEqual({ bin: "claude", args: [] });
  });

  it("appends --resume <id> when resuming a specific conversation", () => {
    expect(buildSpawnArgs("claude", null, { resumeId: "abc-123" })).toEqual({
      bin: "claude",
      args: ["--resume", "abc-123"],
    });
  });

  it("uses --session for opencode, placed after the model flag", () => {
    expect(buildSpawnArgs("opencode", "anthropic/claude-sonnet-5", { resumeId: "ses_123" })).toEqual({
      bin: "opencode",
      args: ["--model", "anthropic/claude-sonnet-5", "--session", "ses_123"],
    });
  });

  it("only auto-approves when explicitly configured", () => {
    const previous = config.permissionMode;
    config.permissionMode = "auto";
    try {
      expect(buildSpawnArgs("opencode", null).args).toContain("--auto");
      expect(buildSpawnArgs("claude", null).args).toContain("--dangerously-skip-permissions");
    } finally {
      config.permissionMode = previous;
    }
  });

  it("mints a brand-new claude conversation under a caller-chosen id with --session-id", () => {
    expect(buildSpawnArgs("claude", null, { sessionId: "11111111-1111-1111-1111-111111111111" })).toEqual({
      bin: "claude",
      args: ["--session-id", "11111111-1111-1111-1111-111111111111"],
    });
  });

  it("ignores sessionId for opencode — no equivalent flag", () => {
    expect(buildSpawnArgs("opencode", null, { sessionId: "ses_123" }).args).not.toContain("ses_123");
  });

  it("appends --fork-session alongside --resume for Claude", () => {
    expect(buildSpawnArgs("claude", null, { resumeId: "abc-123", fork: true }).args).toEqual([
      "--resume",
      "abc-123",
      "--fork-session",
    ]);
  });

  it("appends --fork alongside --session for opencode", () => {
    expect(buildSpawnArgs("opencode", null, { resumeId: "ses_123", fork: true }).args).toEqual([
      "--session",
      "ses_123",
      "--fork",
    ]);
  });

  it("never forks without a resumeId to fork from", () => {
    expect(buildSpawnArgs("claude", null, { fork: true }).args).not.toContain("--fork-session");
  });

  it("appends --effort <level> for claude", () => {
    expect(buildSpawnArgs("claude", "sonnet", { effort: "high" })).toEqual({
      bin: "claude",
      args: ["--model", "sonnet", "--effort", "high"],
    });
  });

  it("omits the effort argument for OpenCode", () => {
    expect(buildSpawnArgs("opencode", null, { effort: "high" }).args).not.toContain("--effort");
  });

  it("omits --effort when null or not given", () => {
    expect(buildSpawnArgs("claude", null).args).not.toContain("--effort");
    expect(buildSpawnArgs("claude", null, { effort: null }).args).not.toContain("--effort");
  });

  it("starts and resumes Codex using its interactive CLI", () => {
    expect(buildSpawnArgs("codex", null).args).toEqual([
      "--no-daemon",
      "--no-alt-screen",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "on-request",
    ]);
    expect(buildSpawnArgs("codex", "gpt-6-luna", { resumeId: "abc-123" }).args).toEqual([
      "--no-daemon",
      "--no-alt-screen",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "on-request",
      "--model",
      "gpt-6-luna",
      "resume",
      "abc-123",
    ]);
  });
});
