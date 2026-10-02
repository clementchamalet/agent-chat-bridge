import type Database from "better-sqlite3";
import { config } from "../config.js";
import { bootstrapIdentity, liveSessionName } from "../pty/tmux.js";
import type { Engine, SessionRecord, SessionState } from "../types.js";

interface SessionRow {
  jid: string;
  workingDir: string;
  engine: string;
  model: string | null;
  effort: string | null;
  state: string;
  ptyPid: number | null;
  waitingSince: string | null;
  executionStartedAt: string | null;
  tmuxSession: string;
  resumeId: string | null;
  title: string | null;
  started: number;
  verbose: number;
  resolvedModel: string | null;
  updatedAt: string;
}

function rowToRecord(row: SessionRow): SessionRecord {
  return {
    jid: row.jid,
    workingDir: row.workingDir,
    engine: row.engine as Engine,
    model: row.model,
    effort: row.effort,
    state: row.state as SessionState,
    ptyPid: row.ptyPid,
    waitingSince: row.waitingSince,
    executionStartedAt: row.executionStartedAt,
    tmuxSession: row.tmuxSession,
    resumeId: row.resumeId,
    title: row.title,
    started: !!row.started,
    verbose: !!row.verbose,
    resolvedModel: row.resolvedModel,
    updatedAt: row.updatedAt,
  };
}

export class SessionRepository {
  constructor(private readonly db: Database.Database) {}

  private record(row: SessionRow): SessionRecord {
    if (!row.tmuxSession) {
      const identity = row.resumeId
        ? { resumeId: row.resumeId, tmuxSession: liveSessionName(row.engine as Engine, row.resumeId) }
        : bootstrapIdentity(row.engine as Engine, row.jid);
      this.db
        .prepare("UPDATE sessions SET tmuxSession = ?, resumeId = ? WHERE jid = ?")
        .run(identity.tmuxSession, identity.resumeId, row.jid);
      row = { ...row, ...identity };
    }
    return rowToRecord(row);
  }

  getOrCreate(jid: string): SessionRecord {
    const existing = this.get(jid);
    if (existing) return existing;

    const identity = bootstrapIdentity(config.defaultEngine, jid);
    this.db
      .prepare(
        `INSERT INTO sessions (jid, workingDir, engine, model, state, tmuxSession, resumeId)
         VALUES (@jid, @workingDir, @engine, @model, 'IDLE', @tmuxSession, @resumeId)`,
      )
      .run({
        jid,
        workingDir: config.defaultCwd,
        engine: config.defaultEngine,
        model: config.defaultModel,
        tmuxSession: identity.tmuxSession,
        resumeId: identity.resumeId,
      });

    const created = this.get(jid);
    if (!created) throw new Error(`Failed to create session for ${jid}`);
    return created;
  }

  get(jid: string): SessionRecord | null {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE jid = ?`).get(jid) as SessionRow | undefined;
    if (!row) return null;
    return this.record(row);
  }

  listAll(): SessionRecord[] {
    const rows = this.db.prepare(`SELECT * FROM sessions`).all() as SessionRow[];
    return rows.map((row) => this.record(row));
  }

  listByState(state: SessionState): SessionRecord[] {
    const rows = this.db.prepare(`SELECT * FROM sessions WHERE state = ?`).all(state) as SessionRow[];
    return rows.map((row) => this.record(row));
  }

  update(jid: string, patch: Partial<Omit<SessionRecord, "jid" | "updatedAt">>): SessionRecord {
    const current = this.getOrCreate(jid);
    const next: SessionRecord = { ...current, ...patch };
    if (patch.state && patch.executionStartedAt === undefined) {
      if (patch.state === "EXECUTING" && (current.state !== "EXECUTING" || !current.executionStartedAt)) {
        next.executionStartedAt = new Date().toISOString();
      } else if (patch.state !== "EXECUTING") {
        next.executionStartedAt = null;
      }
    }

    this.db
      .prepare(
        `UPDATE sessions SET
           workingDir = @workingDir,
           engine = @engine,
           model = @model,
           effort = @effort,
           state = @state,
           ptyPid = @ptyPid,
           waitingSince = @waitingSince,
           executionStartedAt = @executionStartedAt,
           tmuxSession = @tmuxSession,
           resumeId = @resumeId,
           title = @title,
           started = @started,
           verbose = @verbose,
           resolvedModel = @resolvedModel,
           updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE jid = @jid`,
      )
      .run({
        ...next,
        executionStartedAt: next.executionStartedAt ?? null,
        started: next.started ? 1 : 0,
        verbose: next.verbose ? 1 : 0,
      });

    const updated = this.get(jid);
    if (!updated) throw new Error(`Session ${jid} vanished during update`);
    return updated;
  }

  setState(jid: string, state: SessionState, extra: Partial<SessionRecord> = {}): SessionRecord {
    return this.update(jid, { state, ...extra });
  }
}
