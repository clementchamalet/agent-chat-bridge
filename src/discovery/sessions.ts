import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Engine } from "../types.js";
import { findExternalResumeProcesses } from "./externalProcess.js";
import { isBridgeSessionName, liveSessionName } from "../pty/tmux.js";

export interface DiscoveredSession {
  engine: Engine;
  /** Engine-specific conversation ID. */
  resumeId: string;
  directory: string;
  title: string;
  updatedAt: number;
  /** Whether a bridge tmux session is already running this exact conversation. */
  live: boolean;
  /** Deterministic tmux session name for this (engine, resumeId) — see pty/tmux.ts. */
  tmuxSession: string;
  /** Another process (Desktop app, a plain terminal) already has this exact conversation open — see externalProcess.ts. */
  activeElsewhere: boolean;
  sizeBytes?: number;
}

const MAX_RESULTS = 30;
const CLAUDE_HEAD_READ_BYTES = 16_384;
const CLAUDE_TAIL_READ_BYTES = 65_536;
const UNTITLED = "(untitled)";

function listLiveBridgeTmuxSessions(): Set<string> {
  try {
    const out = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set(out.split("\n").filter((n) => n.length > 0 && isBridgeSessionName(n)));
  } catch {
    return new Set();
  }
}

interface ClaudeFileCandidate {
  file: string;
  sessionId: string;
  mtimeMs: number;
  sizeBytes: number;
}

function listClaudeFileCandidates(root: string): ClaudeFileCandidate[] {
  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(root);
  } catch {
    return [];
  }

  const out: ClaudeFileCandidate[] = [];
  for (const dir of projectDirs) {
    const projectPath = path.join(root, dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const file = path.join(projectPath, entry.name);
      try {
        const stat = fs.statSync(file);
        out.push({
          file,
          sessionId: entry.name.slice(0, -".jsonl".length),
          mtimeMs: stat.mtimeMs,
          sizeBytes: stat.size,
        });
      } catch {
        // Vanished between readdir and stat — skip it.
      }
    }
  }
  return out;
}

function readWindow(fd: number, fileSize: number, start: number, length: number): string {
  const clampedStart = Math.max(0, start);
  const buf = Buffer.alloc(Math.min(length, fileSize - clampedStart));
  const bytesRead = fs.readSync(fd, buf, 0, buf.length, clampedStart);
  return buf.toString("utf8", 0, bytesRead);
}

function parseRecord(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Best-effort `{cwd, title}` from a Claude Code transcript. */
function readClaudeMeta(file: string): { cwd: string; title: string } | null {
  let fd: number;
  let fileSize: number;
  try {
    fd = fs.openSync(file, "r");
    fileSize = fs.fstatSync(fd).size;
  } catch {
    return null;
  }

  try {
    let cwd: string | null = null;
    let fallbackTitle: string | null = null;
    for (const line of readWindow(fd, fileSize, 0, CLAUDE_HEAD_READ_BYTES).split("\n")) {
      if (!line.trim()) continue;
      const record = parseRecord(line);
      if (!record) continue;

      if (!cwd && typeof record.cwd === "string") cwd = record.cwd;

      if (!fallbackTitle && record.type === "user") {
        const content = (record.message as { content?: unknown } | undefined)?.content;
        const text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? (
                  content.find((c) => c && typeof c === "object" && (c as { type?: string }).type === "text") as
                    | { text?: string }
                    | undefined
                )?.text
              : undefined;
        if (typeof text === "string" && text.trim()) fallbackTitle = text.replace(/\s+/g, " ").trim().slice(0, 80);
      }

      if (cwd && fallbackTitle) break;
    }

    if (!cwd) return null;

    let customTitle: string | null = null;
    let aiTitle: string | null = null;
    const tailStart = Math.max(0, fileSize - CLAUDE_TAIL_READ_BYTES);
    for (const line of readWindow(fd, fileSize, tailStart, CLAUDE_TAIL_READ_BYTES).split("\n")) {
      if (!line.trim()) continue;
      const record = parseRecord(line);
      if (!record) continue;
      if (record.type === "custom-title" && typeof record.customTitle === "string") {
        customTitle = record.customTitle;
      } else if (record.type === "ai-title" && typeof record.aiTitle === "string") {
        aiTitle = record.aiTitle;
      }
    }

    return { cwd, title: customTitle ?? aiTitle ?? fallbackTitle ?? UNTITLED };
  } finally {
    fs.closeSync(fd);
  }
}

/** `root` is injectable for tests — defaults to the real `~/.claude/projects`. */
export function discoverClaudeSessions(root = path.join(os.homedir(), ".claude", "projects")): DiscoveredSession[] {
  const candidates = listClaudeFileCandidates(root)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_RESULTS * 2);

  const sessions: DiscoveredSession[] = [];
  for (const candidate of candidates) {
    const meta = readClaudeMeta(candidate.file);
    if (!meta) continue;
    sessions.push({
      engine: "claude",
      resumeId: candidate.sessionId,
      directory: meta.cwd,
      title: meta.title,
      updatedAt: candidate.mtimeMs,
      live: false,
      tmuxSession: liveSessionName("claude", candidate.sessionId),
      activeElsewhere: false, // computed in discoverSessions()'s merge step
      sizeBytes: candidate.sizeBytes,
    });
  }
  return sessions;
}

interface OpencodeSessionRow {
  id: string;
  title?: string;
  updated: number;
  directory: string;
}

export function discoverOpencodeSessions(): DiscoveredSession[] {
  let raw: string;
  try {
    raw = execFileSync("opencode", ["session", "list", "--format", "json", "-n", String(MAX_RESULTS * 2)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
  } catch {
    return [];
  }

  let rows: OpencodeSessionRow[];
  try {
    rows = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!Array.isArray(rows)) return [];
  return rows
    .filter(
      (row) =>
        row &&
        typeof row.id === "string" &&
        row.id.length > 0 &&
        typeof row.directory === "string" &&
        row.directory.length > 0 &&
        Number.isFinite(row.updated),
    )
    .map((row) => ({
      engine: "opencode" as const,
      resumeId: row.id,
      directory: row.directory,
      title: typeof row.title === "string" ? row.title.trim() || UNTITLED : UNTITLED,
      updatedAt: row.updated,
      live: false,
      tmuxSession: liveSessionName("opencode", row.id),
      activeElsewhere: false, // computed in discoverSessions()'s merge step
    }));
}

export function discoverCodexSessions(root = path.join(os.homedir(), ".codex", "sessions")): DiscoveredSession[] {
  const files: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) files.push(full);
    }
  };
  walk(root, 0);
  const candidates = files
    .flatMap((file) => {
      try {
        const stat = fs.statSync(file);
        return [{ file, mtimeMs: stat.mtimeMs, sizeBytes: stat.size }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_RESULTS * 2);

  return candidates.flatMap(({ file, mtimeMs, sizeBytes }) => {
    try {
      const fd = fs.openSync(file, "r");
      let head: string;
      try {
        head = readWindow(fd, sizeBytes, 0, 65_536);
      } finally {
        fs.closeSync(fd);
      }
      const first = JSON.parse(head.split("\n")[0] ?? "") as { type?: string; payload?: { id?: string; cwd?: string } };
      if (
        first?.type !== "session_meta" ||
        typeof first.payload?.id !== "string" ||
        !first.payload.id ||
        typeof first.payload.cwd !== "string" ||
        !first.payload.cwd
      )
        return [];
      let title = UNTITLED;
      for (const line of head.split("\n").slice(1)) {
        let record: { type?: string; payload?: { type?: string; message?: string } };
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (
          record?.type === "event_msg" &&
          record.payload?.type === "user_message" &&
          typeof record.payload.message === "string"
        ) {
          title = record.payload.message.replace(/\s+/g, " ").trim().slice(0, 80);
          break;
        }
      }
      return [
        {
          engine: "codex" as const,
          resumeId: first.payload.id,
          directory: first.payload.cwd,
          title,
          updatedAt: mtimeMs,
          live: false,
          tmuxSession: liveSessionName("codex", first.payload.id),
          activeElsewhere: false,
          sizeBytes,
        },
      ];
    } catch {
      return [];
    }
  });
}

export function discoverSessions(): DiscoveredSession[] {
  const liveNames = listLiveBridgeTmuxSessions();
  const merged = [...discoverClaudeSessions(), ...discoverOpencodeSessions(), ...discoverCodexSessions()].map((s) => ({
    ...s,
    live: liveNames.has(s.tmuxSession),
  }));
  merged.sort((a, b) => b.updatedAt - a.updatedAt);
  // Only worth a pgrep call per entry actually shown, not every candidate
  // scanned before the cap below.
  return merged.slice(0, MAX_RESULTS).map((s) => ({
    ...s,
    activeElsewhere: findExternalResumeProcesses(s.engine, s.resumeId, s.tmuxSession).length > 0,
  }));
}
