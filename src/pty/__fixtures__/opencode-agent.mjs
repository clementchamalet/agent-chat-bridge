#!/usr/bin/env node
if (process.stdin.isTTY) process.stdin.setRawMode(true);

let ready = false;
let buffered = "";
let linesOnScreen = 0;

function idleBox() {
  return [
    "  ┃",
    "  ┃",
    "  ┃",
    "  ┃  Build · DeepSeek V4 Pro DeepSeek",
    "  ╹" + "▀".repeat(90),
    "   /tmp/opencode-agent-test              8.1K (1%) · $0.00  ctrl+p commands",
  ];
}

function busyStatusLine() {
  return "   ⬝⬝⬝⬝⬝⬝⬝⬝  esc interrupt                                8.1K (1%) · $0.00  ctrl+p commands";
}

function paint(lines) {
  let out = "";
  for (let i = 0; i < linesOnScreen; i++) out += "\x1b[1A\x1b[2K";
  out += lines.join("\n") + "\n";
  process.stdout.write(out);
  linesOnScreen = lines.length;
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (!ready) return;
  buffered += chunk;
  if (!buffered.includes("\r") && !buffered.includes("\n")) return;
  const input = buffered.replace(/[\r\n]+$/, "");
  buffered = "";

  const echo = ["  ┃", `  ┃  ${input}`, "  ┃", ""];

  paint([...echo, "     ▣  Build · DeepSeek V4 Pro", "", ...idleBox().slice(0, -1), busyStatusLine()]);

  setTimeout(() => {
    const isToolCall = input.includes("tool");
    const body = isToolCall
      ? ["  ┃", "  ┃  # Wrote reply.txt", "  ┃", "  ┃   1 done", "  ┃", "", "     Wrote it.", ""]
      : [`     Reply to: ${input}`, ""];
    paint([...echo, ...body, "     ▣  Build · DeepSeek V4 Pro · 1.2s", "", ...idleBox()]);
  }, 1400);
});

paint([
  "                                         █▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█",
  "",
  "  ┃",
  '  ┃  Ask anything... "Fix a TODO in the codebase"',
  "  ┃",
  "  ┃  Build · DeepSeek V4 Pro DeepSeek",
  "  ╹" + "▀".repeat(90),
  "   /tmp/opencode-agent-test              0.0K (0%) · $0.00  ctrl+p commands",
]);
setTimeout(() => {
  ready = true;
}, 300);
setTimeout(() => process.exit(0), 14000);
