import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPidAlive, readClaudeSessionRegistry } from "./sessionRegistry.js";

describe("readClaudeSessionRegistry", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-sessions-registry-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when the directory doesn't exist — signals a full fallback to pgrep", () => {
    expect(readClaudeSessionRegistry(path.join(dir, "does-not-exist"))).toBeNull();
  });

  it("reads valid entries", () => {
    fs.writeFileSync(
      path.join(dir, "123.json"),
      JSON.stringify({ pid: 123, sessionId: "abc-def", cwd: "/Users/example/project", entrypoint: "claude-desktop" }),
    );

    const entries = readClaudeSessionRegistry(dir);
    expect(entries).toEqual([{ pid: 123, sessionId: "abc-def", cwd: "/Users/example/project" }]);
  });

  it("skips a .key file and any non-.json file", () => {
    fs.writeFileSync(path.join(dir, "123.abcdef.key"), "not json");
    fs.writeFileSync(path.join(dir, "notes.txt"), "not json either");

    expect(readClaudeSessionRegistry(dir)).toEqual([]);
  });

  it("skips an entry with malformed JSON instead of failing the whole read", () => {
    fs.writeFileSync(path.join(dir, "111.json"), "{not valid json");
    fs.writeFileSync(path.join(dir, "222.json"), JSON.stringify({ pid: 222, sessionId: "s2", cwd: "/tmp" }));

    expect(readClaudeSessionRegistry(dir)).toEqual([{ pid: 222, sessionId: "s2", cwd: "/tmp" }]);
  });

  it("skips entries missing a required field", () => {
    fs.writeFileSync(path.join(dir, "333.json"), JSON.stringify({ pid: 333, cwd: "/tmp" }));
    fs.writeFileSync(path.join(dir, "444.json"), JSON.stringify({ pid: 444, sessionId: "s4", cwd: "/tmp" }));

    expect(readClaudeSessionRegistry(dir)).toEqual([{ pid: 444, sessionId: "s4", cwd: "/tmp" }]);
  });
});

describe("isPidAlive", () => {
  it("is true for the current process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("is false once a spawned process has exited", async () => {
    const child: ChildProcess = spawn("node", ["-e", "process.exit(0)"], { stdio: "ignore" });
    await new Promise((resolve) => child.once("exit", resolve));
    expect(isPidAlive(child.pid!)).toBe(false);
  });
});
