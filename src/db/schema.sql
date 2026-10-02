CREATE TABLE IF NOT EXISTS sessions (
  jid         TEXT PRIMARY KEY,
  workingDir  TEXT NOT NULL,
  engine      TEXT NOT NULL DEFAULT 'claude',
  model       TEXT,
  -- Optional Claude Code effort level.
  effort      TEXT,
  state       TEXT NOT NULL DEFAULT 'IDLE',
  ptyPid      INTEGER,
  waitingSince TEXT,
  executionStartedAt TEXT,
  -- Current tmux session.
  tmuxSession TEXT NOT NULL DEFAULT '',
  -- Agent conversation ID; assigned after startup for OpenCode and Codex.
  resumeId    TEXT,
  -- Display name, when known.
  title       TEXT,
  -- Whether this conversation was spawned before.
  started     INTEGER NOT NULL DEFAULT 0,
  -- Progress messages are enabled by default.
  verbose     INTEGER NOT NULL DEFAULT 1,
  -- Cached display model for reattached sessions.
  resolvedModel TEXT,
  updatedAt   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_state ON sessions (state);
