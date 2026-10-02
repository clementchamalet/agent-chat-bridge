import type { Engine } from "../types.js";

export type FrameClassification = "question" | "complete" | "working" | "ambiguous";

// Explicit CLI-decision markers: a live y/n, an "overwrite?"-style
// confirmation, a menu-selection prompt. These are strong enough that they
// win even if the frame also shows an idle-looking empty prompt below them.
const STRONG_QUESTION_PATTERNS: RegExp[] = [
  /\((y\/n|yes\/no)\)/i,
  /\[(y\/n|yes\/no)\]/i,
  /\by\/n\b/i,
  /select\s+(an?\s+)?option/i,
  /which\s+(one|file|option|directory)/i,
  /choose\s+(an?|one)/i,
  /do you want/i,
  /would you like/i,
  /proceed\?/i,
  /continue\?/i,
  /press\s+enter/i,
  /confirm\b/i,
  /overwrite\b/i,
];

const WEAK_QUESTION_PATTERN = /\?\s*$/m;

const CURSOR_LINE = /^(?:\s*[❯>]\s+\S|\s*›\s+\d+[.)]\s+\S)/;
const OTHER_OPTION_LINE = /^\s*(\d+[.)]|[-*•○●])\s+\S/;
// How many lines apart a cursor line and an option line can be and still
// plausibly be the same menu — real Ink menus render every option
// contiguously, with at most a line or two of incidental spacing.
const MENU_ADJACENCY_WINDOW = 2;

const IDLE_FOOTER_LINE_PATTERNS: RegExp[] = [
  /for shortcuts/i,
  /ctrl\+c to exit/i,
  /ctrl-c to exit/i,
  /context left/i,
  /bypass permissions on/i,
  /shift\+tab to cycle/i,
  /^\s*[>❯]\s*$/, // an empty input prompt — Claude Code uses the Unicode ❯, not ASCII >
  /^[\s─│┃━┏┓┗┛╭╮╰╯▔▁=_-]*$/, // pure box-drawing/rule lines carry no content
  /●\s*(high|medium|low)\s*·\s*\/effort/i,
  /^\s*⧉\s+\S/,
];

const BUSY_LINE_PATTERN = /esc to interrupt/i;

const OPENCODE_IDLE_FOOTER_LINE_PATTERNS: RegExp[] = [
  /ctrl\+p commands/i,
  /^\s*┃\s+Ask anything/i,
  /^\s*┃\s+.*·.*DeepSeek\b/i,
  /^\s*┃\s*$/, // a blank box row — pure framing, same idea as Claude Code's bare "❯"
  /^[\s─│┃━┏┓┗┛╭╮╰╯▔▁█▀▄▌▐╹=_-]*$/, // rule/box-drawing-only lines — extends Claude Code's own char set with OpenCode's block-art glyphs (banner, box borders)
  /^\s*\+\s+Thought:\s*[\d.]+[a-z]+\s*$/i,
];

// OpenCode's busy footer reads "⬝⬝⬝⬝⬝⬝⬝⬝  esc interrupt   ...  ctrl+p
// commands" — no "to" the way Claude Code's "esc to interrupt" hint has.
const OPENCODE_BUSY_LINE_PATTERN = /esc\s+interrupt/i;
const CODEX_PROMPT = /^\s*›\s+(?:Ask Codex to do anything)?\s*$/i;
const CODEX_FOOTER = /←\s*for agents|\/model to change/i;
const CODEX_BUSY = /(?:esc\s+to\s+interrupt|working\s*\(|thinking\s*\()/i;

const OPENCODE_TURN_FOOTER_PATTERN = /^\s*▣\s+\S.*·/;
const OPENCODE_ECHO_LINE = /^\s*┃\s+\S/;

function isChromeLine(line: string, engine: Engine = "claude"): boolean {
  if (engine === "codex") return CODEX_PROMPT.test(line) || CODEX_FOOTER.test(line) || /^\s*GPT-\S+.*·.*←/.test(line);
  if (engine === "opencode") {
    return OPENCODE_IDLE_FOOTER_LINE_PATTERNS.some((re) => re.test(line)) || OPENCODE_BUSY_LINE_PATTERN.test(line);
  }
  return IDLE_FOOTER_LINE_PATTERNS.some((re) => re.test(line)) || BUSY_LINE_PATTERN.test(line);
}

function hasIdleInputBox(lines: string[], engine: Engine = "claude"): boolean {
  if (engine === "codex") {
    if (lines.some((line) => CODEX_BUSY.test(line))) return false;
    return lines.some((line) => CODEX_PROMPT.test(line));
  }
  if (engine === "opencode") {
    return lines.some((l) => l.trim().length > 0 && OPENCODE_IDLE_FOOTER_LINE_PATTERNS.some((re) => re.test(l)));
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    if (/^\s*[>❯]/.test(line)) return true;
    if (isChromeLine(line)) continue;
    return false; // real content first — this isn't the trailing input box
  }
  return false;
}

function latestTurnLines(lines: string[], engine: Engine = "claude"): string[] {
  if (engine === "opencode") return latestTurnLinesOpenCode(lines);
  let lastEchoIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^❯\s+\S/.test(lines[i]!)) {
      lastEchoIdx = i;
      break;
    }
  }
  return lastEchoIdx === -1 ? lines : lines.slice(lastEchoIdx + 1);
}

function latestTurnLinesOpenCode(lines: string[]): string[] {
  const footerIdxs: number[] = [];
  lines.forEach((l, i) => {
    if (OPENCODE_TURN_FOOTER_PATTERN.test(l)) footerIdxs.push(i);
  });

  let searchFrom = 0;
  if (footerIdxs.length > 0) {
    const lastFooterIdx = footerIdxs[footerIdxs.length - 1]!;
    const newTurnAlreadyStarted = lines.slice(lastFooterIdx + 1).some((l) => OPENCODE_ECHO_LINE.test(l));
    if (newTurnAlreadyStarted) {
      searchFrom = lastFooterIdx + 1;
    } else if (footerIdxs.length >= 2) {
      searchFrom = footerIdxs[footerIdxs.length - 2]! + 1;
    }
  }
  return lines.slice(searchFrom);
}

function hasMenu(lines: string[], engine: Engine): boolean {
  const cursorIdxs: number[] = [];
  const optionIdxs: number[] = [];
  lines.forEach((l, i) => {
    if (isChromeLine(l, engine)) return;
    if (CURSOR_LINE.test(l)) cursorIdxs.push(i);
    if (OTHER_OPTION_LINE.test(l)) optionIdxs.push(i);
  });
  return cursorIdxs.some((ci) => optionIdxs.some((oi) => Math.abs(ci - oi) <= MENU_ADJACENCY_WINDOW));
}

export function classifyFrame(frameText: string, engine: Engine = "claude"): FrameClassification {
  const text = frameText.trim();
  if (text.length === 0) return "ambiguous";

  const lines = text.split("\n");
  if (engine === "codex") {
    if (lines.some((line) => CODEX_BUSY.test(line))) return "working";
    if (hasMenu(lines, engine)) return "question";
    if (hasIdleInputBox(lines, engine)) return "complete";
    if (STRONG_QUESTION_PATTERNS.some((pattern) => pattern.test(text))) return "question";
    return "ambiguous";
  }
  const contentLines = lines.filter((l) => !isChromeLine(l, engine));
  const latestContentText = latestTurnLines(contentLines, engine).join("\n");

  if (hasMenu(lines, engine)) return "question";

  if (engine === "claude") {
    if (lines.some((l) => BUSY_LINE_PATTERN.test(l))) return "working";
    if (hasIdleInputBox(lines, engine)) return "complete";
  }

  if (STRONG_QUESTION_PATTERNS.some((re) => re.test(latestContentText))) return "question";

  const busyPattern = engine === "opencode" ? OPENCODE_BUSY_LINE_PATTERN : BUSY_LINE_PATTERN;
  if (lines.some((l) => busyPattern.test(l))) return "working";

  // A ready-to-type prompt is decisive: the agent is done with this turn.
  // Checked before the weak trailing-"?" signal so a chatty closing remark
  // ("...today?") doesn't get mistaken for a live blocking question.
  if (hasIdleInputBox(lines, engine)) return "complete";

  if (WEAK_QUESTION_PATTERN.test(latestContentText)) return "question";

  const looksIdle = lines.some((l) => isChromeLine(l, engine) && l.trim().length > 0);
  if (looksIdle) return "complete";

  return "ambiguous";
}

export function isReadyForInput(frameText: string, engine: Engine = "claude"): boolean {
  const text = frameText.trim();
  if (!text) return false;
  const lines = text.split("\n");
  if (engine === "codex") return hasIdleInputBox(lines, engine) && !hasMenu(lines, engine);
  if (hasMenu(lines, engine)) return false;
  const busyPattern = engine === "opencode" ? OPENCODE_BUSY_LINE_PATTERN : BUSY_LINE_PATTERN;
  if (lines.some((l) => busyPattern.test(l))) return false;
  return hasIdleInputBox(lines, engine);
}

/** Whether the screen shows a navigable menu (cursor line plus adjacent sibling options) — see hasMenu. */
export function frameHasMenu(frameText: string, engine: Engine = "claude"): boolean {
  return hasMenu(frameText.trim().split("\n"), engine);
}

export function trustDialogDownPresses(frameText: string): number | null {
  if (!/trust this folder|one you trust/i.test(frameText)) return null;
  const lines = frameText.split("\n");
  const yes = lines.findIndex((l) => /Yes, I trust/i.test(l));
  if (yes === -1) return null;
  let cursor = -1;
  for (let i = Math.max(0, yes - 3); i <= Math.min(lines.length - 1, yes + 3); i++) {
    if (/^\s*❯\s+\S/.test(lines[i]!)) cursor = i;
  }
  if (cursor === -1) return null;
  return yes - cursor;
}

export interface MenuOptions {
  /** 0-based index of the currently highlighted option. */
  cursorIndex: number;
  /** Total number of options in the menu. */
  count: number;
}

/** Where a cursor line's own option text starts, e.g. " ❯ No, exit" → 3. -1 if the line isn't actually a cursor line. */
function cursorContentColumn(cursorLine: string): number {
  const m = /^(\s*)[❯>›](\s+)/.exec(cursorLine);
  if (!m) return -1;
  return m[1]!.length + 1 + m[2]!.length;
}

export function parseMenu(frameText: string): MenuOptions | null {
  const lines = frameText.split("\n");
  const cursorIdxs: number[] = [];
  lines.forEach((l, i) => {
    if (CURSOR_LINE.test(l)) cursorIdxs.push(i);
  });
  if (cursorIdxs.length !== 1) return null;
  const cursorIdx = cursorIdxs[0]!;

  const col = cursorContentColumn(lines[cursorIdx]!);
  if (col < 0) return null;

  const isSibling = (line: string): boolean => {
    if (OTHER_OPTION_LINE.test(line)) return true;
    if (line.length <= col) return false;
    return line.slice(0, col).trim() === "" && line[col] !== " ";
  };

  let start = cursorIdx;
  while (start > 0 && isSibling(lines[start - 1]!)) start--;
  let end = cursorIdx;
  while (end < lines.length - 1 && isSibling(lines[end + 1]!)) end++;

  const count = end - start + 1;
  if (count < 2) return null; // a single "option" isn't a navigable menu

  return { cursorIndex: cursorIdx - start, count };
}
