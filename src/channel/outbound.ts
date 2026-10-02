const LEGACY_META_LINE = /^_[^\n_]+(?:\s+·\s+[^\n_]+){1,4}_$/;
const TOOL_HEAD = /^[A-Z][A-Za-z0-9]*\([^\n]*\)\s*$/;
const TOOL_SUMMARY =
  /^(?:Ran|Running|Searched for|Listed|Read)\b.*\b(?:shell commands?|patterns?|files?|directories?)\b/i;

// These are deliberately line-oriented. A terminal status line is not
// conversational content and should never be allowed to become a partial
// sentence in WhatsApp when a new CLI version changes its wording slightly.
const HARNESS_LINES: RegExp[] = [
  /^\s*[✻✢✳✶✽·]\s*\S+\s+for\s+[\d.]+[a-z]+(?:\s+[\d.]+[a-z]+)*(?:\s*·\s*done\b.*)?\s*$/i,
  /^\s*[✻✢✳✶✽·]?\s*\S+…\s*\([^)]*\b(?:tokens?)\b[^)]*\)\s*$/i,
  /^\s*●\s*(?:low|medium|high|xhigh|max)\s*·\s*\/effort\s*$/i,
  /^\s*❯\s*(?:.*)?$/,
  /^\s*>\s*$/,
  /\bnew task\?.*\/clear.*\btokens?\b/i,
  /\b(?:tokens? remaining|context window|quota|rate limit|usage limit)\b/i,
  /\b(?:esc to interrupt|shift\+tab to cycle|ctrl\+[a-z] commands)\b/i,
];

function isHarnessLine(line: string): boolean {
  return HARNESS_LINES.some((pattern) => pattern.test(line));
}

function parseToolCount(line: string): number {
  const trimmed = line.trim();
  const italic = /^_(.*)_$/.exec(trimmed)?.[1]?.trim() ?? trimmed;
  const withoutMarker = italic.replace(/^⏺\s?/, "").trim();

  if (withoutMarker === "⎿" || withoutMarker.startsWith("⎿")) return 0;
  if (TOOL_HEAD.test(withoutMarker)) return 1;

  const summary = withoutMarker.match(/(\d+)\s*\b(?:shell commands?|patterns?|files?|directories?)\b/i);
  if (summary && (TOOL_SUMMARY.test(withoutMarker) || italic !== trimmed)) {
    return Number(summary[1]);
  }

  // OpenCode's inline and boxed tool markers are synthesized by
  // frameSummary for normal PTY output, but accepting them here makes the
  // boundary safe for reattached/older frames too.
  if (/^[→✱]\s+\S+\s+.+$/.test(withoutMarker) || /^┃\s+[#$←]\s+.+$/.test(withoutMarker)) return 1;
  return 0;
}

function isToolLine(line: string): boolean {
  const trimmed = line.trim();
  if (/^_?⎿/.test(trimmed)) return true;
  const inner = /^_(.*)_$/.exec(trimmed)?.[1]?.trim() ?? trimmed;
  const withoutMarker = inner.replace(/^⏺\s?/, "").trim();
  return (
    parseToolCount(line) > 0 ||
    withoutMarker.startsWith("⎿") ||
    TOOL_SUMMARY.test(withoutMarker) ||
    /^[→✱]\s+\S+\s+.+$/.test(withoutMarker) ||
    /^┃\s+[#$←]\s+.+$/.test(withoutMarker)
  );
}

/** Counts tool calls without exposing their names, paths, or commands. */
export function countToolCalls(text: string): number {
  return text.split("\n").reduce((total, line) => total + parseToolCount(line), 0);
}

export function stripLegacyFooter(text: string): string {
  return text
    .split("\n")
    .filter((line) => !LEGACY_META_LINE.test(line.trim()))
    .join("\n");
}

export function formatAgentContent(input: string): string {
  const text = stripLegacyFooter(input).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  const toolCount = countToolCalls(text);
  const prose: string[] = [];
  let inToolDetail = false;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();

    if (inToolDetail) {
      if (line === "") inToolDetail = false;
      else continue;
    }

    if (isHarnessLine(rawLine)) continue;
    if (isToolLine(rawLine)) {
      if (/^_?⎿/.test(line)) inToolDetail = true;
      continue;
    }

    // Response markers are CLI chrome, but the text after one is the
    // agent's actual sentence.
    const withoutMarker = rawLine.replace(/^\s*⏺\s?/, "");
    if (withoutMarker.trim()) prose.push(withoutMarker.trimEnd());
    else prose.push("");
  }

  const body = prose
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const toolSummary = toolCount > 0 ? `> (${toolCount} ${toolCount === 1 ? "command run" : "commands run"})` : "";

  return [toolSummary, body].filter(Boolean).join("\n\n");
}

function stripEmphasis(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1");
}

function inlineMarkdownToWhatsApp(line: string): string {
  const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
  if (heading) return `*${stripEmphasis(heading[1]!.trim())}*`;

  // A leading "* " bullet would read as the start of WhatsApp bold.
  let out = line.replace(/^(\s*)[*+]\s+/, "$1- ");

  // Inline code spans are left verbatim (WhatsApp renders `code` itself) and
  // shielded from the emphasis rewrites below.
  const codeSpans: string[] = [];
  out = out.replace(/`[^`\n]+`/g, (span) => {
    codeSpans.push(span);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });

  // Markdown **bold**/__bold__ → WhatsApp *bold*; Markdown *italic* →
  // WhatsApp _italic_ (a single asterisk means bold on WhatsApp). Bold is
  // parked on a sentinel first so the italic pass can't touch it.
  out = out.replace(/\*\*(.+?)\*\*/g, "\u0001$1\u0001").replace(/__(.+?)__/g, "\u0001$1\u0001");
  out = out.replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1_$2_");
  out = out.replace(/\u0001/g, "*");
  out = out.replace(/~~(.+?)~~/g, "~$1~");
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)");

  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codeSpans[Number(i)] ?? "");
}

export function markdownToWhatsApp(markdown: string): string {
  const out: string[] = [];
  let inFence = false;
  let table: string[] = [];
  const flushTable = () => {
    if (table.length === 0) return;
    out.push("```", ...table, "```");
    table = [];
  };

  for (const raw of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (/^\s*```/.test(line)) {
      flushTable();
      out.push("```");
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (!/^\s*\|[\s:|-]+\|\s*$/.test(line)) table.push(line.trim()); // skip the |---|---| separator row
      continue;
    }
    flushTable();
    out.push(inlineMarkdownToWhatsApp(line));
  }
  flushTable();
  if (inFence) out.push("```");

  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Formats transcript text with an aggregate tool count. */
export function formatTranscriptReply(text: string, toolCount: number): string {
  const body = markdownToWhatsApp(text);
  const toolSummary = toolCount > 0 ? `> (${toolCount} ${toolCount === 1 ? "command run" : "commands run"})` : "";
  return [toolSummary, body].filter(Boolean).join("\n\n");
}

export function formatDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return "0m";
  const seconds = Math.floor(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}

/** Model and timing metadata for agent replies. */
export function formatRunFooter(model: string | null, effort: string | null, durationMs: number | null): string {
  const level = effort?.trim();
  const parts = [model?.trim() || "unknown model"];
  if (level && level !== "n/a") parts.push(level);
  parts.push(formatDuration(durationMs));
  return `_${parts.join(" · ")}_`;
}
