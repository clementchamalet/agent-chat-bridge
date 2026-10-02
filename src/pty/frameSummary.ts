import type { Engine } from "../types.js";
import { frameHasMenu } from "./promptDetector.js";

const CHROME_LINE_PATTERNS: RegExp[] = [
  /Tips for getting started/i,
  /Welcome back/i,
  /What'?s new/i,
  /release-notes/i,
  /Keep working from anywhere/i,
  /Check progress or reply/i,
  /clone a repository/i,
  /create a new app/i,
  /Claude Code v\d/i,
  /Tackle your toughest work/i,
  /'s Organization\b/i,
  /·\s*Claude (Pro|Team|Max|Free)\b/i,
  /\s{3,}~\/[\w.-]*\s{2,}/, // cwd shown padded inside a banner column, e.g. "   ~/Projects   "
  /\bAdded a /i,
  /\bFixed `/i,
  /remote-control/i,
  /●\s*(high|medium|low|xhigh|max)\s*·\s*\/effort/i,
  /bypass permissions on/i,
  /shift\+tab to cycle/i,
  /\/rc (active|connecting)/i,
  /^\s*[✻✢✳✶·]?\s*\S+\s+for\s+[\d.]+[a-z]+(\s*·\s*done\b.*)?\s*$/i,
  /^\s*[✻✢✳✶✽·]?\s*\S+…\s*\([^)]*·\s*[↓↑]\s*[\d.]+[km]?\s*tokens?\)\s*$/i,
  /\btmux\b.*\.tmux\.conf/i, // Rotating tmux tips are UI chrome.
  /esc to interrupt/i, // only shown while actively working (see promptDetector's "working" classification) — a UI hint, not content
  /^\s*⧉\s+\S/,
];

const CODEX_MODEL_FOOTER = /^\s*([\w./:-]+)\s+(?:minimal|low|medium|high|xhigh|max|none)\s*·\s*(?:~?\/|[A-Z]:\\).*$/i;

const CODEX_CHROME_LINE_PATTERNS: RegExp[] = [
  /OpenAI Codex \(v/i,
  /^\s*model:\s+/i,
  /^\s*directory:\s+/i,
  /^\s*Tip:\s+/i,
  /^\s*›\s+Ask Codex to do anything\s*$/i,
  CODEX_MODEL_FOOTER,
  /^\s*Worked for\s+[\d.]+[a-z]+(?:\s+[\d.]+[a-z]+)*\s*•\s*\d{1,2}:\d{2}/i,
  /^\s*⚠\s*Heads up, you have less than /i,
];

const OPENCODE_TURN_FOOTER_PATTERN = /^\s*▣\s+\S.*·/;

const OPENCODE_CHROME_LINE_PATTERNS: RegExp[] = [
  /ctrl\+p commands/i,
  /^\s*┃\s+Ask anything/i, // the empty box's placeholder text before any message has ever been sent
  /^\s*┃\s+.*·.*DeepSeek\b/i,
  /^\s*\+\s+Thought:\s*[\d.]+[a-z]+\s*$/i, // "+ Thought: 1.4s" — a completed thinking-time note, not content
];

const EXTRA_BLOCK_DRAWING_CHARS = "█▀▄▌▐╹";

const DIFF_GUTTER_LINE = /^\d+(\s{2,}|\s*[-+])/;

const DIFF_GUTTER_WRAP_CONTINUATION = /^[-+]/;

const WRITE_RESULT_LINE = /^⎿\s*Wrote\s+\d+\s+lines?\s+to\s+/i;
const TRUNCATION_MARKER_LINE = /^\.\.\.\s*\+\d+\s+lines?\s*$/;

const NEW_TOOL_CALL_MARKER = /^⏺/;

function stripToolCallDetail(text: string): string {
  const kept: string[] = [];
  let inGutterBlock = false;
  let inWriteResultBlock = false;
  let inResultDetailBlock = false;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();

    if (inWriteResultBlock) {
      if (TRUNCATION_MARKER_LINE.test(trimmed)) {
        inWriteResultBlock = false;
        continue; // the marker itself is just noise, not content
      }
      if (trimmed === "") {
        inWriteResultBlock = false;
        kept.push(line);
        continue;
      }
      continue; // still inside the new file's inlined content — drop it
    }

    if (inResultDetailBlock) {
      if (trimmed === "" || NEW_TOOL_CALL_MARKER.test(trimmed)) {
        inResultDetailBlock = false;
        // fall through — this line itself still needs normal processing
      } else {
        continue; // still the same wrapped/multi-line "⎿" result — drop it
      }
    }

    if (WRITE_RESULT_LINE.test(trimmed)) {
      kept.push(line); // keep the "⎿ Wrote N lines to <path>" summary itself
      inWriteResultBlock = true;
      continue;
    }

    if (DIFF_GUTTER_LINE.test(trimmed)) {
      inGutterBlock = true;
      continue;
    }
    if (inGutterBlock && DIFF_GUTTER_WRAP_CONTINUATION.test(trimmed)) {
      continue; // still the same wrapped logical line — drop it too
    }
    inGutterBlock = false;

    if (TOOL_RESULT_LINE.test(trimmed)) {
      kept.push(line); // keep the "⎿ <result>" head itself
      inResultDetailBlock = true;
      continue;
    }

    kept.push(line);
  }

  return kept.join("\n");
}

const TOOL_CALL_HEAD = /^[A-Z][A-Za-z0-9]*\([^)]*\)\s*$/;
const TOOL_RESULT_LINE = /^⎿/;
const TOOL_SUMMARY_LINE = /^(Ran|Running|Searched for|Listed|Read)\b.*(shell command|pattern|file|director)/i;

/** Strips the "⏺" response marker and, for a tool-call line, wraps it in WhatsApp italics (`_..._`) to de-emphasize it against the agent's own prose. */
function formatToolCallLines(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const leading = line.slice(0, line.length - line.trimStart().length);
      const withoutMarker = line.trim().replace(/^⏺\s?/, "");
      if (!withoutMarker) return leading;
      const isToolLine =
        TOOL_RESULT_LINE.test(withoutMarker) ||
        TOOL_SUMMARY_LINE.test(withoutMarker) ||
        TOOL_CALL_HEAD.test(withoutMarker);
      return isToolLine ? `${leading}_${withoutMarker}_` : `${leading}${withoutMarker}`;
    })
    .join("\n");
}

const LIST_ITEM_START = /^(?:\d+[.)]|[-*•])\s+\S/;
const HEADING_START = /^#{1,6}\s/;
const TABLE_ROW_LINE = /^\|.*\|\s*$/;
const ITALIC_LINE = /^_.*_$/;

/** Whether `line` starts a new structural block — a wrapped continuation of the previous line never looks like this. */
function startsNewBlock(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "") return true;
  return (
    LIST_ITEM_START.test(trimmed) ||
    HEADING_START.test(trimmed) ||
    TABLE_ROW_LINE.test(trimmed) ||
    ITALIC_LINE.test(trimmed) ||
    TOOL_RESULT_LINE.test(trimmed)
  );
}

/** Whether `line` reads as cut off mid-sentence — the case for rejoining it with whatever comes next. */
function endsMidSentence(line: string): boolean {
  const trimmed = line.trimEnd();
  if (trimmed === "" || TABLE_ROW_LINE.test(trimmed) || ITALIC_LINE.test(trimmed)) return false;
  // Final punctuation can follow whitespace or appear inside closing quotes and brackets.
  return !/[.!?:;)\]}"'»›]$/.test(trimmed);
}

function reflowWrappedProse(text: string): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const prev = out.length > 0 ? out[out.length - 1]! : null;
    if (prev !== null && !startsNewBlock(line) && endsMidSentence(prev)) {
      out[out.length - 1] = `${prev.trimEnd()} ${line.trim()}`;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

const OPENCODE_BOXED_TOOL_HEAD = /^┃\s+([#$←])\s+(.+)$/;
const OPENCODE_BOXED_LINE = /^┃/;
const OPENCODE_INLINE_TOOL_LINE = /^[→✱]\s+(.+)$/;

const OPENCODE_VERB_TO_TOOL_NAME: Record<string, string> = {
  wrote: "Write",
  created: "Write",
  write: "Write",
  create: "Write",
  edited: "Edit",
  updated: "Edit",
  edit: "Edit",
  update: "Edit",
};

function synthesizeOpencodeBoxedTool(marker: string, rest: string): string {
  if (marker === "$") return `Bash(${rest})`;
  const m = /^(\S+)\s+(.+)$/.exec(rest);
  if (!m) return rest;
  const toolName = OPENCODE_VERB_TO_TOOL_NAME[m[1]!.toLowerCase()] ?? m[1];
  return `${toolName}(${m[2]})`;
}

function synthesizeOpencodeInlineTool(rest: string): string {
  // "Read test.txt" → Read(test.txt); 'Grep "hello"' → Grep(hello) — the
  // verb is always the line's own first word, so no marker-to-verb mapping
  // is needed here the way the boxed "#" header above needs one.
  const m = /^(\S+)\s+(.+)$/.exec(rest);
  if (!m) return rest;
  return `${m[1]}(${m[2]!.replace(/^"|"$/g, "")})`;
}

function formatToolCallLinesOpenCode(text: string): string {
  const out: string[] = [];
  let inBoxedToolDetail = false;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();

    if (trimmed === "") {
      inBoxedToolDetail = false;
      out.push(line);
      continue;
    }

    const boxedHead = OPENCODE_BOXED_TOOL_HEAD.exec(trimmed);
    if (boxedHead) {
      out.push(`_${synthesizeOpencodeBoxedTool(boxedHead[1]!, boxedHead[2]!)}_`);
      inBoxedToolDetail = true;
      continue;
    }

    if (inBoxedToolDetail && OPENCODE_BOXED_LINE.test(trimmed)) continue; // raw output/diff under a boxed call — detail, not summary

    inBoxedToolDetail = false;

    const inline = OPENCODE_INLINE_TOOL_LINE.exec(trimmed);
    if (inline) {
      out.push(`_${synthesizeOpencodeInlineTool(inline[1]!)}_`);
      continue;
    }

    out.push(line);
  }

  return out.join("\n");
}

interface ToolCategory {
  singular: string;
  plural: string;
}

const TOOL_CATEGORIES = {
  command: { singular: "command run", plural: "commands run" },
  fileEdit: { singular: "file edited", plural: "files edited" },
  fileRead: { singular: "file read", plural: "files read" },
  search: { singular: "search", plural: "searches" },
  webSearch: { singular: "web search", plural: "web searches" },
  webFetch: { singular: "page fetched", plural: "pages fetched" },
  agent: { singular: "agent started", plural: "agents started" },
  todo: { singular: "task updated", plural: "tasks updated" },
  dir: { singular: "directory explored", plural: "directories explored" },
  other: { singular: "action", plural: "actions" },
} as const satisfies Record<string, ToolCategory>;

// Keyed by the tool-call head's name, e.g. "Write" in "Write(hello.md)" —
// covers both Claude Code's and OpenCode's naming for the same underlying
// action (Claude Code renders an edit as "Update(path)", not "Edit(path)").
const TOOL_NAME_CATEGORY: Record<string, ToolCategory> = {
  Bash: TOOL_CATEGORIES.command,
  BashOutput: TOOL_CATEGORIES.command,
  KillShell: TOOL_CATEGORIES.command,
  Write: TOOL_CATEGORIES.fileEdit,
  Update: TOOL_CATEGORIES.fileEdit,
  Edit: TOOL_CATEGORIES.fileEdit,
  NotebookEdit: TOOL_CATEGORIES.fileEdit,
  Read: TOOL_CATEGORIES.fileRead,
  Glob: TOOL_CATEGORIES.search,
  Grep: TOOL_CATEGORIES.search,
  WebSearch: TOOL_CATEGORIES.webSearch,
  WebFetch: TOOL_CATEGORIES.webFetch,
  Task: TOOL_CATEGORIES.agent,
  TodoWrite: TOOL_CATEGORIES.todo,
};

function categoryForSummaryKeyword(keyword: string): ToolCategory {
  if (/shell command/i.test(keyword)) return TOOL_CATEGORIES.command;
  if (/pattern/i.test(keyword)) return TOOL_CATEGORIES.search;
  if (/director/i.test(keyword)) return TOOL_CATEGORIES.dir;
  if (/file/i.test(keyword)) return TOOL_CATEGORIES.fileRead;
  return TOOL_CATEGORIES.other;
}

/** e.g. "ran 1 shell command" → { n: 1, cat: command } — a single TOOL_SUMMARY_LINE bundles several of these, comma-separated. */
function parseSummaryClause(clause: string): { n: number; cat: ToolCategory } | null {
  const match = /(\d+)\s*(shell commands?|patterns?|director\w*|files?)/i.exec(clause);
  if (!match) return null;
  return { n: Number(match[1]), cat: categoryForSummaryKeyword(match[2]!) };
}

function addCount(counts: Map<ToolCategory, number>, cat: ToolCategory, n: number): void {
  counts.set(cat, (counts.get(cat) ?? 0) + n);
}

export function compactToolActivity(text: string): string {
  const counts = new Map<ToolCategory, number>();
  const prose: string[] = [];

  for (const line of text.split("\n")) {
    const match = /^_(.*)_$/.exec(line.trim());
    if (!match) {
      prose.push(line);
      continue;
    }
    const inner = match[1]!;

    if (TOOL_RESULT_LINE.test(inner)) continue; // folded into the head line's count, not its own

    if (TOOL_SUMMARY_LINE.test(inner)) {
      for (const clause of inner.split(",")) {
        const parsed = parseSummaryClause(clause);
        if (parsed) addCount(counts, parsed.cat, parsed.n);
      }
      continue;
    }

    const head = /^([A-Z][A-Za-z0-9]*)\(/.exec(inner);
    if (head) {
      addCount(counts, TOOL_NAME_CATEGORY[head[1]!] ?? TOOL_CATEGORIES.other, 1);
      continue;
    }

    // Italicized but not a recognized tool-line shape (e.g. the "model ·
    // effort · time" meta footer) — not tool activity, keep as-is.
    prose.push(line);
  }

  const summary = [...counts.entries()].map(([cat, n]) => `${n} ${n === 1 ? cat.singular : cat.plural}`).join(", ");

  const proseText = prose
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!summary) return proseText;
  return proseText ? `> _${summary}_\n\n${proseText}` : `> _${summary}_`;
}

const BOX_DRAWING_CHAR_CLASS = new RegExp(`[╭╮╰╯│─┃━┏┓┗┛▔▁${EXTRA_BLOCK_DRAWING_CHARS}]`, "g");

function isBoxDrawingLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  const boxChars = (trimmed.match(BOX_DRAWING_CHAR_CLASS) ?? []).length;
  return boxChars / trimmed.length > 0.3;
}

/** Strips persistent Claude Code/OpenCode UI chrome, keeping just the actual conversation content. */
export function summarizeFrame(frameText: string, engine: Engine = "claude"): string {
  const patterns =
    engine === "opencode"
      ? OPENCODE_CHROME_LINE_PATTERNS
      : engine === "codex"
        ? CODEX_CHROME_LINE_PATTERNS
        : CHROME_LINE_PATTERNS;
  const lines = frameText.split("\n");
  const kept = lines.filter((line) => {
    if (isBoxDrawingLine(line)) return false;
    return !patterns.some((re) => re.test(line));
  });

  const collapsed: string[] = [];
  for (const line of kept) {
    const isBlank = line.trim().length === 0;
    if (isBlank && collapsed[collapsed.length - 1]?.trim() === "") continue;
    collapsed.push(line);
  }

  while (collapsed.length > 0 && collapsed[0]!.trim() === "") collapsed.shift();
  while (collapsed.length > 0 && collapsed[collapsed.length - 1]!.trim() === "") collapsed.pop();

  return collapsed.join("\n");
}

export function extractEffort(rawFrame: string): string | null {
  return /●\s*(high|medium|low|xhigh|max)\s*·\s*\/effort/i.exec(rawFrame)?.[1]?.toLowerCase() ?? null;
}

export function extractElapsed(rawFrame: string): string | null {
  return /\S+\s+for\s+([\d.]+[a-z]+)\b/i.exec(rawFrame)?.[1] ?? null;
}

const BUSY_SPINNER_ELAPSED_TOKENS = /\S+…\s*\(([^)·]+)·\s*[↓↑]\s*([\d.]+[km]?)\s*tokens?\)/i;

export function extractElapsedBusy(rawFrame: string): string | null {
  return BUSY_SPINNER_ELAPSED_TOKENS.exec(rawFrame)?.[1]?.trim() ?? null;
}

export function extractTokens(rawFrame: string): string | null {
  const n = BUSY_SPINNER_ELAPSED_TOKENS.exec(rawFrame)?.[2];
  return n ? `${n} tokens` : null;
}

export function extractModelName(rawFrame: string): string | null {
  return /\b((?:Fable|Sonnet|Opus|Haiku)\s*[\d.]*)\s*(?:with\s+\S+\s+effort\s*)?·/i.exec(rawFrame)?.[1]?.trim() ?? null;
}

export function extractModelNameCodex(rawFrame: string): string | null {
  const match = rawFrame
    .split("\n")
    .map((line) => CODEX_MODEL_FOOTER.exec(line))
    .findLast((candidate) => candidate !== null);
  return match?.[1] ?? /^\s*[│┃]?\s*model:\s*(\S+)/im.exec(rawFrame)?.[1] ?? null;
}

const OPENCODE_TURN_FOOTER_LINE = /^\s*▣\s+(.+)$/gm;

function lastOpenCodeTurnFooterLine(rawFrame: string): string | null {
  const matches = [...rawFrame.matchAll(OPENCODE_TURN_FOOTER_LINE)];
  return matches.length > 0 ? matches[matches.length - 1]![1]!.trim() : null;
}

/** OpenCode's per-turn footer elapsed time, e.g. "Build · DeepSeek V4 Pro · 2.9s" → "2.9s". Null while the turn is still generating (no elapsed segment yet). */
export function extractElapsedOpenCode(rawFrame: string): string | null {
  const line = lastOpenCodeTurnFooterLine(rawFrame);
  if (!line) return null;
  const parts = line.split("·").map((s) => s.trim());
  const last = parts[parts.length - 1];
  return last && /^[\d.]+[a-z]+$/i.test(last) ? last : null;
}

/** OpenCode's per-turn footer model name, e.g. "Build · DeepSeek V4 Pro · 2.9s" → "DeepSeek V4 Pro". */
export function extractModelNameOpenCode(rawFrame: string): string | null {
  const line = lastOpenCodeTurnFooterLine(rawFrame);
  if (!line) return null;
  const parts = line.split("·").map((s) => s.trim());
  return parts[1] || null;
}

export interface ExtractedReply {
  /** Small footer line, e.g. "Sonnet 5 · high · 4s" — empty if nothing was extractable. */
  meta: string;
  /** The actual content to show: the agent's reply (or the full chrome-stripped screen for a menu/prompt). */
  body: string;
}

const OPENCODE_ECHO_LINE = /^┃\s+\S/;

/** Isolate the latest OpenCode turn and remove its echoed input. */
function isolateLatestTurnOpenCode(lines: string[]): string[] {
  const footerIdxs: number[] = [];
  lines.forEach((l, i) => {
    if (OPENCODE_TURN_FOOTER_PATTERN.test(l)) footerIdxs.push(i);
  });

  let searchFrom = 0;
  if (footerIdxs.length > 0) {
    const lastFooterIdx = footerIdxs[footerIdxs.length - 1]!;
    const newTurnAlreadyStarted = lines.slice(lastFooterIdx + 1).some((l) => OPENCODE_ECHO_LINE.test(l.trim()));
    if (newTurnAlreadyStarted) {
      searchFrom = lastFooterIdx + 1;
    } else if (footerIdxs.length >= 2) {
      searchFrom = footerIdxs[footerIdxs.length - 2]! + 1;
    }
    // else: exactly one footer and nothing echoed after it — that's the
    // very first turn's own end; nothing earlier to skip past.
  }

  let scoped = lines.slice(searchFrom);
  while (scoped.length > 0 && scoped[0]!.trim() === "") scoped.shift();

  // A long prompt can wrap onto several physical lines, each still
  // "┃"-prefixed (unlike Claude Code, where only the first wrapped line
  // gets the "❯" marker) — drop the whole contiguous run, not just one line.
  while (scoped.length > 0 && OPENCODE_ECHO_LINE.test(scoped[0]!.trim())) scoped.shift();
  while (scoped.length > 0 && scoped[0]!.trim() === "") scoped.shift();

  return scoped;
}

function extractReplyOpenCode(rawFrame: string, fallbackModelName: string | null): ExtractedReply {
  const modelName = extractModelNameOpenCode(rawFrame) ?? fallbackModelName;
  const elapsed = extractElapsedOpenCode(rawFrame);
  const meta = [modelName, elapsed].filter((v): v is string => Boolean(v)).join(" · ");

  const chromeStripped = summarizeFrame(rawFrame, "opencode").split("\n");
  let lines = isolateLatestTurnOpenCode(chromeStripped);
  lines = lines.filter((l) => !OPENCODE_TURN_FOOTER_PATTERN.test(l));

  const body = reflowWrappedProse(formatToolCallLinesOpenCode(lines.join("\n")))
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { meta, body: body || summarizeFrame(rawFrame, "opencode") };
}

function extractReplyClaude(rawFrame: string, modelName: string | null, fallbackEffort: string | null): ExtractedReply {
  const effort = extractEffort(rawFrame) ?? fallbackEffort;
  const elapsed = extractElapsedBusy(rawFrame) ?? extractElapsed(rawFrame);
  const tokens = extractTokens(rawFrame);
  const meta = [modelName, effort, elapsed, tokens].filter((v): v is string => Boolean(v)).join(" · ");

  let lines = summarizeFrame(rawFrame).split("\n");

  while (lines.length > 0 && /^\s*[>❯]/.test(lines[lines.length - 1]!)) {
    lines.pop();
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  }

  let lastEchoIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^❯\s+\S/.test(lines[i]!)) {
      lastEchoIdx = i;
      break;
    }
  }
  if (lastEchoIdx !== -1) {
    let start = lastEchoIdx + 1;
    while (start < lines.length && lines[start]!.trim() !== "" && !TOOL_RESULT_LINE.test(lines[start]!.trim())) {
      start++;
    }
    lines = lines.slice(start);
    while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  } else {
    const firstBulletIdx = lines.findIndex((l) => /^⏺\s?\S/.test(l.trim()));
    if (firstBulletIdx !== -1) lines = lines.slice(firstBulletIdx);
    // Preserve the frame when no reply marker is available.
  }

  const body = reflowWrappedProse(formatToolCallLines(stripToolCallDetail(lines.join("\n"))))
    .replace(/\n{3,}/g, "\n\n") // stripped diff hunks can leave stacked blank lines behind
    .trim();

  // If everything got stripped (an edge case, but sending a blank WhatsApp
  // message is worse than an unstripped fallback), fall back to whatever
  // summarizeFrame produced before the echo/empty-prompt trimming above.
  return { meta, body: body || summarizeFrame(rawFrame) };
}

function formatCodexTerminal(text: string): string {
  const blocks = text.split(/(?=^\s{0,2}•\s)/m);
  return blocks
    .map((block) => {
      if (
        /^\s*•\s+(?:Ran|Running|Explored|Edited|Added|Deleted|Updated|Searched|Read)\b/.test(block) ||
        (/^\s*•\s/.test(block) && /^\s*[└│]/m.test(block))
      )
        return "_Tool(action)_";
      return block.replace(/^\s*•\s+/, "");
    })
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractReply(
  rawFrame: string,
  modelName: string | null = null,
  fallbackEffort: string | null = null,
  engine: Engine = "claude",
): ExtractedReply {
  if (engine === "opencode") return extractReplyOpenCode(rawFrame, modelName);
  if (engine === "codex") {
    if (frameHasMenu(rawFrame, "codex")) return { meta: "", body: summarizeFrame(rawFrame, "codex") };
    const lines = summarizeFrame(rawFrame, "codex").split("\n");
    const lastPrompt = lines.findLastIndex((line) => /^\s*›\s+\S/.test(line));
    let start = lastPrompt + 1;
    // Wrapped input stays indented until the blank line preceding the reply.
    if (lastPrompt >= 0) {
      while (start < lines.length && /^\s+\S/.test(lines[start]!) && !/^\s*[•■⚠]/.test(lines[start]!)) start++;
    }
    let body = lines
      .slice(start)
      .filter((line) => !/^\s*›\s*$/.test(line))
      .join("\n")
      .trim();
    if (/^■\s*\{/.test(body)) {
      const json = body.replace(/^■\s*/, "").split("\n").join(" ");
      body = "❌ Codex could not complete the request. Use /screen for details.";
      try {
        const payload = JSON.parse(json) as {
          type?: string;
          error?: { message?: unknown };
        };
        if (payload.type === "error" && typeof payload.error?.message === "string") {
          body = `❌ ${payload.error.message}`;
        }
      } catch {}
    }
    return { meta: "", body: formatCodexTerminal(body) };
  }
  return extractReplyClaude(rawFrame, modelName, fallbackEffort);
}
