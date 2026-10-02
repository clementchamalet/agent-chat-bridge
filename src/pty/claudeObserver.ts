import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ClaudeRegistryStatus = "busy" | "idle" | "waiting";

export interface ClaudeRegistrySnapshot {
  status: ClaudeRegistryStatus | null;
  sessionId: string | null;
}

function sessionsDir(): string {
  return path.join(os.homedir(), ".claude", "sessions");
}

function projectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/** The registry entry of one specific Claude Code process, or null if absent/unreadable (not written yet during boot, or mid-rewrite). */
export function readClaudeRegistryForPid(pid: number, dir = sessionsDir()): ClaudeRegistrySnapshot | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, `${pid}.json`), "utf8");
  } catch {
    return null;
  }
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const status = o.status === "busy" || o.status === "idle" || o.status === "waiting" ? o.status : null;
    return { status, sessionId: typeof o.sessionId === "string" ? o.sessionId : null };
  } catch {
    return null;
  }
}

export function prettyModelName(id: string): string | null {
  const m = /^claude-([a-z]+)((?:-\d+)*)$/i.exec(id.trim().replace(/-\d{8}$/, ""));
  if (!m) return null;
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase();
  const version = m[2]!.split("-").filter(Boolean).join(".");
  return version ? `${family} ${version}` : family;
}

/** Claude Code's own project-directory naming: every non-alphanumeric character of the cwd becomes "-". */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Finds a Claude transcript by session ID, including sessions started elsewhere. */
export function findClaudeTranscript(sessionId: string, cwd: string | null, root = projectsDir()): string | null {
  if (cwd) {
    const expected = path.join(root, claudeProjectDirName(cwd), `${sessionId}.jsonl`);
    if (fs.existsSync(expected)) return expected;
  }
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(root, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export type TranscriptRecord = Record<string, unknown>;

export class TranscriptTail {
  private offset: number;
  private remainder: Buffer = Buffer.alloc(0);

  constructor(
    readonly file: string,
    startOffset = 0,
  ) {
    this.offset = startOffset;
  }

  /** Byte offset of the first not-yet-returned complete line. */
  get position(): number {
    return this.offset - this.remainder.length;
  }

  readNew(): TranscriptRecord[] {
    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return [];
    }
    if (size < this.offset) {
      // Rewritten/truncated underneath us — start over rather than read garbage.
      this.offset = 0;
      this.remainder = Buffer.alloc(0);
    }
    if (size === this.offset) return [];

    const chunk = Buffer.alloc(size - this.offset);
    let fd: number;
    try {
      fd = fs.openSync(this.file, "r");
    } catch {
      return [];
    }
    let bytesRead = 0;
    try {
      bytesRead = fs.readSync(fd, chunk, 0, chunk.length, this.offset);
    } finally {
      fs.closeSync(fd);
    }
    this.offset += bytesRead;

    const data = Buffer.concat([this.remainder, chunk.subarray(0, bytesRead)]);
    const lastNewline = data.lastIndexOf(0x0a);
    if (lastNewline === -1) {
      this.remainder = data;
      return [];
    }
    this.remainder = data.subarray(lastNewline + 1);

    const records: TranscriptRecord[] = [];
    for (const line of data.subarray(0, lastNewline).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (parsed && typeof parsed === "object") records.push(parsed as TranscriptRecord);
      } catch {
        // A corrupt line shouldn't stall everything after it.
      }
    }
    return records;
  }
}

function userText(record: TranscriptRecord): string | null {
  const content = (record.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter(
        (p): p is { type: string; text: string } =>
          !!p && typeof p === "object" && (p as { type?: unknown }).type === "text",
      )
      .map((p) => p.text);
    return texts.length > 0 ? texts.join("\n") : null;
  }
  return null;
}

/** Whether `record` is a genuine prompt the user (or the bridge on their behalf) submitted — not a tool result, meta injection or sidechain. */
export function isUserPrompt(record: TranscriptRecord): boolean {
  if (record.type !== "user" || record.isSidechain || record.isMeta) return false;
  const content = (record.message as { content?: unknown } | undefined)?.content;
  if (
    Array.isArray(content) &&
    content.some((p) => p && typeof p === "object" && (p as { type?: unknown }).type === "tool_result")
  ) {
    return false;
  }
  const text = userText(record);
  if (text === null) return false;
  if (text.startsWith("<local-command-stdout>") || text.startsWith("<local-command-caveat>")) return false;
  if (text.includes("[Request interrupted by user")) return false;
  return true;
}

/** Whether `record` is Claude itself producing something (text or a tool call) on the main thread — which can open a turn with no prompt at all. */
export function isAssistantActivity(record: TranscriptRecord): boolean {
  if (record.type !== "assistant" || record.isSidechain) return false;
  const content = (record.message as { content?: unknown } | undefined)?.content;
  return (
    Array.isArray(content) &&
    content.some((p) => {
      const type = p && typeof p === "object" ? (p as { type?: unknown }).type : undefined;
      return type === "text" || type === "tool_use";
    })
  );
}

export function latestTurnStartOffset(
  file: string,
  windowBytes = 8 * 1024 * 1024,
  isTurnStart: (record: TranscriptRecord) => boolean = isUserPrompt,
): number {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return 0;
  }
  const start = Math.max(0, size - windowBytes);
  const buf = Buffer.alloc(size - start);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }

  let lineStart = 0;
  if (start > 0) {
    const firstNewline = buf.indexOf(0x0a);
    if (firstNewline === -1) return size;
    lineStart = firstNewline + 1;
  }
  const windowFirstLine = start + lineStart;
  let latest = -1;
  while (lineStart < buf.length) {
    let lineEnd = buf.indexOf(0x0a, lineStart);
    if (lineEnd === -1) lineEnd = buf.length;
    const line = buf.subarray(lineStart, lineEnd).toString("utf8");
    if (line.includes('"type"')) {
      try {
        if (isTurnStart(JSON.parse(line) as TranscriptRecord)) latest = start + lineStart;
      } catch {
        // partial/corrupt line — skip
      }
    }
    lineStart = lineEnd + 1;
  }
  return latest === -1 ? windowFirstLine : latest;
}

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskOption[];
}

export interface PendingAsk {
  toolUseId: string;
  questions: AskQuestion[];
}

function parseAskInput(input: unknown): AskQuestion[] {
  const questions = (input as { questions?: unknown } | undefined)?.questions;
  if (!Array.isArray(questions)) return [];
  return questions
    .filter((q): q is Record<string, unknown> => !!q && typeof q === "object")
    .map((q) => ({
      question: typeof q.question === "string" ? q.question : "",
      header: typeof q.header === "string" ? q.header : undefined,
      multiSelect: q.multiSelect === true,
      options: Array.isArray(q.options)
        ? q.options
            .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
            .map((o) => ({
              label: typeof o.label === "string" ? o.label : "",
              description: typeof o.description === "string" ? o.description : undefined,
            }))
        : [],
    }));
}

export function formatAsk(ask: PendingAsk, index = 0): string {
  const q = ask.questions[index] ?? ask.questions[0];
  if (!q) return "❓ Claude has a question. Use /screen to inspect it.";
  // Channel adapters convert this Markdown to the platform's formatting.
  const head = [
    ask.questions.length > 1 ? `**Question ${index + 1}/${ask.questions.length}**` : null,
    `❓ ${q.header ? `**${q.header}** — ` : ""}${q.question}`,
  ]
    .filter(Boolean)
    .join("\n");
  const options = q.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — *${o.description}*` : ""}`);
  return `${[head, ...options].join("\n")}\n\nReply with a number or enter a free-form answer.`;
}

export interface TurnText {
  id: string;
  text: string;
  sent: boolean;
  /** A tool call came after this block — it was narration ("Let me check X"), not the turn's final answer. */
  followedByTool: boolean;
}

export class ClaudeTurn {
  readonly texts: TurnText[] = [];
  toolCount = 0;
  private toolsReported = 0;
  /** API model id of the latest assistant message — the model actually answering, whatever the chat's own setting says. */
  model: string | null = null;
  pendingAsk: PendingAsk | null = null;
  interrupted = false;
  readonly localOutput: string[] = [];
  sawPrompt = false;
  sawAssistant = false;
  /** A `system`/`turn_duration` record — Claude's own "turn over" marker (not written by every version, so never required). */
  ended = false;
  readonly startedAt = Date.now();

  ingest(record: TranscriptRecord): void {
    if (record.isSidechain) return;

    if (record.type === "system") {
      if (record.subtype === "turn_duration") this.ended = true;
      return;
    }

    if (record.type === "user") {
      const content = (record.message as { content?: unknown } | undefined)?.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (!part || typeof part !== "object") continue;
          const p = part as { type?: string; tool_use_id?: string };
          if (p.type === "tool_result" && this.pendingAsk && p.tool_use_id === this.pendingAsk.toolUseId) {
            this.pendingAsk = null;
          }
        }
      }
      if (record.isMeta) return;
      const text = userText(record);
      if (text === null) return;
      const stdout = /^<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(text);
      if (stdout) {
        const out = stdout[1]!.replace(/\[[0-9;]*m/g, "").trim();
        if (out) this.localOutput.push(out);
        return;
      }
      if (text.includes("[Request interrupted by user")) {
        this.interrupted = true;
        return;
      }
      if (isUserPrompt(record)) {
        this.sawPrompt = true;
        this.ended = false;
      }
      return;
    }

    if (record.type === "assistant") {
      const message = record.message as { content?: unknown; model?: unknown } | undefined;
      if (typeof message?.model === "string" && message.model.startsWith("claude-")) this.model = message.model;
      const content = Array.isArray(message?.content) ? message.content : [];
      const uuid = typeof record.uuid === "string" ? record.uuid : `${this.texts.length}-${Date.now()}`;
      content.forEach((part, i) => {
        if (!part || typeof part !== "object") return;
        const p = part as { type?: string; text?: string; name?: string; id?: string; input?: unknown };
        if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
          this.texts.push({ id: `${uuid}:${i}`, text: p.text.trim(), sent: false, followedByTool: false });
          this.sawAssistant = true;
        } else if (p.type === "tool_use") {
          this.sawAssistant = true;
          if (p.name === "AskUserQuestion") {
            this.pendingAsk = { toolUseId: p.id ?? "", questions: parseAskInput(p.input) };
          } else {
            this.toolCount += 1;
          }
          for (const t of this.texts) t.followedByTool = true;
        } else if (p.type === "thinking") {
          this.sawAssistant = true;
        }
      });
    }
  }

  /** Marks every not-yet-reported text block as sent and returns them, in transcript order. */
  takeUnsent(): string[] {
    const out: string[] = [];
    for (const t of this.texts) {
      if (t.sent) continue;
      t.sent = true;
      out.push(t.text);
    }
    return out;
  }

  hasUnsent(): boolean {
    return this.texts.some((t) => !t.sent);
  }

  takeNarration(): string[] {
    const out: string[] = [];
    for (const t of this.texts) {
      if (t.sent || !t.followedByTool) continue;
      t.sent = true;
      out.push(t.text);
    }
    return out;
  }

  /** Tool calls not yet counted in a message sent for this turn — each call is counted exactly once across progress pings and the final reply. */
  takeToolDelta(): number {
    const delta = this.toolCount - this.toolsReported;
    this.toolsReported = this.toolCount;
    return delta;
  }
}
