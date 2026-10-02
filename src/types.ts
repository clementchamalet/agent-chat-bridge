export type Engine = "claude" | "opencode" | "codex";

export type SessionState = "IDLE" | "EXECUTING" | "WAITING_FOR_INPUT";

export interface SessionRecord {
  /** WhatsApp number or `tg:<user-id>`. */
  jid: string;
  workingDir: string;
  engine: Engine;
  model: string | null;
  /** Optional Claude Code effort level. */
  effort: string | null;
  state: SessionState;
  ptyPid: number | null;
  /** ISO timestamp of entering WAITING_FOR_INPUT, used for the input timeout. */
  waitingSince: string | null;
  executionStartedAt?: string | null;
  /** The tmux session this chat currently talks to — see src/pty/tmux.ts. */
  tmuxSession: string;
  /** Agent conversation ID, independent of its tmux session name. */
  resumeId: string | null;
  /** Best-effort display name — null until known (e.g. picked from /sessions); falls back to the working directory's basename for display. */
  title: string | null;
  /** Whether this conversation was spawned before. */
  started: boolean;
  /** When true, a still-in-progress turn sends incremental "progress" pings, not just the final reply — see /verbose. */
  verbose: boolean;
  /** Cached model label for reattached sessions. */
  resolvedModel: string | null;
  updatedAt: string;
}

export const VALID_ENGINES: readonly Engine[] = ["claude", "opencode", "codex"];
