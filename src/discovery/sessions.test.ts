import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverClaudeSessions, discoverOpencodeSessions } from "./sessions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function writeTranscript(dir: string, sessionId: string, lines: unknown[]): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"));
}

describe("discoverClaudeSessions", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-projects-test-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads the cwd and first user message out of a transcript's opening lines", () => {
    writeTranscript(path.join(root, "-Users-example-Desktop-blog"), "session-a", [
      { type: "user", cwd: "/Users/example/Desktop/blog", message: { content: "  fix the   footer layout  " } },
    ]);

    const [session] = discoverClaudeSessions(root);
    expect(session).toMatchObject({
      engine: "claude",
      resumeId: "session-a",
      directory: "/Users/example/Desktop/blog",
      title: "fix the footer layout",
    });
  });

  it("extracts text from an array-shaped message content", () => {
    writeTranscript(path.join(root, "-Users-example-Desktop-blog"), "session-b", [
      {
        type: "user",
        cwd: "/Users/example/Desktop/blog",
        message: { content: [{ type: "text", text: "array-shaped content" }] },
      },
    ]);

    const [session] = discoverClaudeSessions(root);
    expect(session?.title).toBe("array-shaped content");
  });

  it("prefers Claude Code's own custom-title over the first message's opening words", () => {
    writeTranscript(path.join(root, "-Users-example-Desktop-sample-project"), "session-custom-title", [
      {
        type: "user",
        cwd: "/Users/example/Desktop/sample-project",
        message: { content: "Implement the requested feature." },
      },
      { type: "ai-title", aiTitle: "Feature implementation" },
      { type: "custom-title", customTitle: "Completed feature" },
    ]);

    const [session] = discoverClaudeSessions(root);
    expect(session?.title).toBe("Completed feature");
  });

  it("falls back to the ai-title when there's no custom-title", () => {
    writeTranscript(path.join(root, "-Users-example-Desktop-blog"), "session-ai-title", [
      { type: "user", cwd: "/Users/example/Desktop/blog", message: { content: "fix the footer" } },
      { type: "ai-title", aiTitle: "Footer layout fix" },
    ]);

    const [session] = discoverClaudeSessions(root);
    expect(session?.title).toBe("Footer layout fix");
  });

  it("takes the most recent custom-title when the transcript has several (title changed over time)", () => {
    writeTranscript(path.join(root, "-Users-example-Desktop-blog"), "session-retitled", [
      { type: "user", cwd: "/Users/example/Desktop/blog", message: { content: "fix the footer" } },
      { type: "custom-title", customTitle: "First title" },
      { type: "assistant", message: { content: [{ type: "text", text: "working on it" }] } },
      { type: "custom-title", customTitle: "Renamed later" },
    ]);

    const [session] = discoverClaudeSessions(root);
    expect(session?.title).toBe("Renamed later");
  });

  it("skips a transcript with no cwd anywhere in the read window", () => {
    writeTranscript(path.join(root, "-Users-example-Desktop-blog"), "session-c", [
      { type: "user", message: { content: "no cwd here" } },
    ]);

    expect(discoverClaudeSessions(root)).toEqual([]);
  });

  it("returns an empty list when the projects root doesn't exist", () => {
    expect(discoverClaudeSessions(path.join(root, "does-not-exist"))).toEqual([]);
  });

  it("ignores malformed transcript records without hiding valid session metadata", () => {
    writeTranscript(path.join(root, "sample-project"), "session-invalid-records", [
      null,
      42,
      [],
      {
        type: "user",
        cwd: "/tmp/sample-project",
        message: { content: [{ type: "text", text: 42 }] },
      },
      { type: "user", cwd: "/tmp/sample-project", message: { content: "Find the component" } },
      null,
      "invalid record",
      { type: "custom-title", customTitle: "Component search" },
    ]);
    expect(discoverClaudeSessions(root)).toEqual([
      expect.objectContaining({ directory: "/tmp/sample-project", title: "Component search" }),
    ]);
  });
});

describe("discoverOpencodeSessions", () => {
  let binDir: string;
  let originalPath: string;

  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-fixture-bin-"));
    const fixture = path.join(__dirname, "__fixtures__", "fake-opencode.mjs");
    const shim = path.join(binDir, "opencode");
    fs.copyFileSync(fixture, shim);
    fs.chmodSync(shim, 0o755);

    originalPath = process.env.PATH ?? "";
    process.env.PATH = `${binDir}:${originalPath}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  it("parses the JSON session list from `opencode session list`", () => {
    expect(discoverOpencodeSessions()).toEqual([
      {
        engine: "opencode",
        resumeId: "ses_abc123",
        directory: "/tmp/fake-project",
        title: "Fake opencode session",
        updatedAt: 1700000000000,
        live: false,
        tmuxSession: expect.stringContaining("ses_abc123"),
        activeElsewhere: false,
      },
    ]);
  });

  it("returns an empty list when the opencode binary isn't on PATH", () => {
    process.env.PATH = "";
    expect(discoverOpencodeSessions()).toEqual([]);
  });
});
