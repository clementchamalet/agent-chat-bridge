#!/usr/bin/env node
if (process.stdin.isTTY) process.stdin.setRawMode(true);

let ready = false;
let linesOnScreen = 0;

function paint(lines) {
  let out = "";
  for (let i = 0; i < linesOnScreen; i++) out += "\x1b[1A\x1b[2K";
  out += lines.join("\n") + "\n";
  process.stdout.write(out);
  linesOnScreen = lines.length;
}

process.stdin.setEncoding("utf8");
let buffered = "";
process.stdin.on("data", (chunk) => {
  if (!ready) return;
  buffered += chunk;
  if (buffered.includes("\r") || buffered.includes("\n")) {
    buffered = "";
    let n = 0;
    let contentAdded = false;
    const timer = setInterval(() => {
      n++;
      if (n === 3) contentAdded = true;
      paint(
        contentAdded
          ? ["⏺ Update(a.ts)", "", `✻ Cooking for ${n}s (esc to interrupt)`]
          : [`✻ Cooking for ${n}s (esc to interrupt)`],
      );
    }, 200);
    setTimeout(() => clearInterval(timer), 5000);
  }
});

paint(["Banner", "", "> "]);
setTimeout(() => {
  ready = true;
}, 300);
setTimeout(() => process.exit(0), 8000);
