import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TranscriptTail, latestTurnStartOffset, type TranscriptRecord } from "./claudeObserver.js";

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export interface CodexReply {
  text: string;
  toolCount: number;
}

export class CodexTurn {
  started = false;
  ended = false;
  private turnId: string | null = null;
  private texts: { text: string; phase: unknown; sent: boolean }[] = [];
  private seen = new Set<string>();
  private tools = 0;
  private reportedTools = 0;
  private completed = false;

  reset(): void {
    this.started = false;
    this.ended = false;
    this.turnId = null;
    this.texts = [];
    this.seen.clear();
    this.tools = 0;
    this.reportedTools = 0;
    this.completed = false;
  }

  ingest(record: TranscriptRecord): void {
    const payload = object(record.payload);
    if (!payload) return;
    if (record.type === "event_msg") {
      if (payload.type === "task_started") {
        const id = typeof payload.turn_id === "string" ? payload.turn_id : null;
        if (!this.started || id !== this.turnId) this.reset();
        this.turnId = id;
        this.started = true;
      } else if (payload.type === "task_complete") {
        this.ended = true;
      }
      return;
    }
    if (record.type !== "response_item") return;
    const id = typeof payload.call_id === "string" ? payload.call_id : payload.id;
    if (typeof id === "string") {
      const kind = payload.type === "function_call" || payload.type === "custom_tool_call" ? "tool" : payload.type;
      const key = `${kind}:${id}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
    }
    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      this.tools++;
    } else if (payload.type === "message" && payload.role === "assistant" && Array.isArray(payload.content)) {
      const text = payload.content
        .map((part) => object(part))
        .filter((part) => part?.type === "output_text" && typeof part.text === "string")
        .map((part) => part!.text as string)
        .join("\n")
        .trim();
      if (text) this.texts.push({ text, phase: payload.phase, sent: false });
    }
  }

  private take(final: boolean): CodexReply | null {
    const texts = this.texts.filter((item) => !item.sent && (final || item.phase === "commentary"));
    if (texts.length === 0 && !final) return null;
    for (const item of texts) item.sent = true;
    const toolCount = this.tools - this.reportedTools;
    this.reportedTools = this.tools;
    return { text: texts.map((item) => item.text).join("\n\n"), toolCount };
  }

  takeProgress(): CodexReply | null {
    return this.started && !this.ended ? this.take(false) : null;
  }

  takeFinal(): CodexReply | null {
    if (!this.started || !this.ended || this.completed) return null;
    this.completed = true;
    return this.take(true);
  }
}

function findTranscript(
  cwd: string,
  sessionId: string | null,
  since: number,
  prompt: string | null,
  root: string,
): string | null {
  const candidates: { file: string; modified: number }[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file, depth + 1);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        try {
          const modified = fs.statSync(file).mtimeMs;
          if (sessionId ? entry.name.endsWith(`${sessionId}.jsonl`) : modified >= since) {
            candidates.push({ file, modified });
          }
        } catch {}
      }
    }
  };
  walk(root, 0);
  candidates.sort((a, b) => b.modified - a.modified);
  for (const { file } of candidates) {
    try {
      const fd = fs.openSync(file, "r");
      const buffer = Buffer.alloc(128 * 1024);
      let size: number;
      try {
        size = fs.readSync(fd, buffer, 0, buffer.length, 0);
      } finally {
        fs.closeSync(fd);
      }
      const records = buffer
        .subarray(0, size)
        .toString("utf8")
        .split("\n")
        .flatMap((line) => {
          try {
            return [object(JSON.parse(line))];
          } catch {
            return [];
          }
        });
      const metadata = object(records[0]?.payload);
      if (metadata?.cwd !== cwd || (sessionId && metadata.id !== sessionId)) continue;
      if (!sessionId && prompt) {
        const matches = records.some((record) => {
          const payload = object(record?.payload);
          return (
            payload?.role === "user" &&
            Array.isArray(payload.content) &&
            payload.content.some((part) => {
              const content = object(part);
              return typeof content?.text === "string" && content.text.trim() === prompt.trim();
            })
          );
        });
        if (!matches) continue;
      }
      return file;
    } catch {}
  }
  return null;
}

export class CodexObserver {
  readonly turn = new CodexTurn();
  private tail: TranscriptTail | null = null;
  private prompt: string | null = null;
  private lastLookup = 0;

  constructor(
    private readonly cwd: string,
    private readonly sessionId: string | null,
    private readonly since: number,
    private readonly root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions"),
  ) {}

  submitted(text: string): void {
    if (this.tail) this.read();
    if (this.turn.ended || !this.turn.started) this.turn.reset();
    this.prompt = text;
  }

  read(): void {
    if (!this.tail && !this.sessionId && !this.prompt) return;
    if (!this.tail && Date.now() - this.lastLookup >= 1000) {
      this.lastLookup = Date.now();
      const file = findTranscript(this.cwd, this.sessionId, this.since, this.prompt, this.root);
      if (file) {
        const start = latestTurnStartOffset(
          file,
          undefined,
          (record) => record.type === "event_msg" && object(record.payload)?.type === "task_started",
        );
        this.tail = new TranscriptTail(file, start);
      }
    }
    for (const record of this.tail?.readNew() ?? []) this.turn.ingest(record);
  }
}
