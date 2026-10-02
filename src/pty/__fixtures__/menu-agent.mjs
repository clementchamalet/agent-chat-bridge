#!/usr/bin/env node
if (process.stdin.isTTY) process.stdin.setRawMode(true);

const options = ["Resume from summary (recommended)", "Resume full session as-is"];
let cursor = 0;
let linesOnScreen = 0;

function render() {
  return [
    "This session is large. How do you want to resume it?",
    "",
    ...options.map((opt, i) => (i === cursor ? `❯ ${opt}` : `  ${opt}`)),
  ];
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
  if (chunk === "\x1b[A") {
    cursor = Math.max(0, cursor - 1);
    paint(render());
  } else if (chunk === "\x1b[B") {
    cursor = Math.min(options.length - 1, cursor + 1);
    paint(render());
  } else if (chunk === "\r" || chunk === "\n") {
    paint([`CONFIRMED: ${options[cursor]}`, "", "> "]);
  }
});

paint(render());
setTimeout(() => process.exit(0), 8000);
