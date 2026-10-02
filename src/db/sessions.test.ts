import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./database.js";
import { SessionRepository } from "./sessions.js";

describe("SessionRepository", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-db-test-")), "bridge.sqlite3");
  });

  afterEach(() => {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("mints a real resumeId and derives tmuxSession from it on creation", () => {
    const repo = new SessionRepository(openDatabase(dbPath));
    const session = repo.getOrCreate("15550100123");
    expect(session.resumeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.tmuxSession).toBe(`wa-claude-${session.resumeId}`);
    expect(session.started).toBe(false);
  });

  it("persists an updated tmuxSession", () => {
    const repo = new SessionRepository(openDatabase(dbPath));
    repo.getOrCreate("15550100123");
    const updated = repo.update("15550100123", { tmuxSession: "wa-claude-abc123" });
    expect(updated.tmuxSession).toBe("wa-claude-abc123");
    expect(repo.get("15550100123")?.tmuxSession).toBe("wa-claude-abc123");
  });

  it("backfills tmuxSession for a database created before that column existed", () => {
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE sessions (
        jid TEXT PRIMARY KEY,
        workingDir TEXT NOT NULL,
        engine TEXT NOT NULL DEFAULT 'claude',
        model TEXT,
        state TEXT NOT NULL DEFAULT 'IDLE',
        ptyPid INTEGER,
        waitingSince TEXT,
        updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);
    raw.prepare(`INSERT INTO sessions (jid, workingDir) VALUES (?, ?)`).run("15550100123", "/Users/example/Projects");
    raw.close();

    const repo = new SessionRepository(openDatabase(dbPath));
    const session = repo.get("15550100123");
    expect(session?.resumeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(session?.tmuxSession).toBe(`wa-claude-${session?.resumeId}`);
    expect(repo.get("15550100123")).toEqual(session);
    expect(repo.listAll()).toEqual([session]);
    expect(repo.listByState("IDLE")).toEqual([session]);
  });

  it("rejects a newer database without creating tables", () => {
    const raw = new Database(dbPath);
    raw.pragma("user_version = 999");
    raw.close();
    expect(() => openDatabase(dbPath)).toThrow("newer than this bridge supports");
    const reopened = new Database(dbPath);
    expect(reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
    reopened.close();
  });

  it("persists resumeId, title and started", () => {
    const repo = new SessionRepository(openDatabase(dbPath));
    repo.getOrCreate("15550100123");
    const updated = repo.update("15550100123", { resumeId: "abc-123", title: "Fix footer", started: true });
    expect(updated).toMatchObject({ resumeId: "abc-123", title: "Fix footer", started: true });
    expect(repo.get("15550100123")).toMatchObject({ resumeId: "abc-123", title: "Fix footer", started: true });
  });

  it("tracks task start across state changes", () => {
    const db = openDatabase(dbPath);
    const repo = new SessionRepository(db);
    repo.getOrCreate("15550100123");
    const running = repo.setState("15550100123", "EXECUTING");
    expect(running.executionStartedAt).toMatch(/^\d{4}-/);
    expect(repo.setState("15550100123", "EXECUTING").executionStartedAt).toBe(running.executionStartedAt);
    expect(repo.setState("15550100123", "IDLE").executionStartedAt).toBeNull();
    expect(db.pragma("user_version", { simple: true })).toBe(3);
    db.close();
  });

  it("drops a leftover resumeNext column from an older install without erroring", () => {
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE sessions (
        jid TEXT PRIMARY KEY,
        workingDir TEXT NOT NULL,
        engine TEXT NOT NULL DEFAULT 'claude',
        model TEXT,
        state TEXT NOT NULL DEFAULT 'IDLE',
        ptyPid INTEGER,
        waitingSince TEXT,
        tmuxSession TEXT NOT NULL DEFAULT '',
        resumeNext INTEGER NOT NULL DEFAULT 0,
        updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);
    raw
      .prepare(`INSERT INTO sessions (jid, workingDir, tmuxSession) VALUES (?, ?, ?)`)
      .run("15550100123", "/Users/example/Projects", "wa-claude-abc");
    raw.close();

    const db = openDatabase(dbPath);
    const columns = (db.pragma("table_info(sessions)") as { name: string }[]).map((c) => c.name);
    expect(columns).not.toContain("resumeNext");

    const repo = new SessionRepository(db);
    expect(repo.get("15550100123")?.tmuxSession).toBe("wa-claude-abc");
  });
});
