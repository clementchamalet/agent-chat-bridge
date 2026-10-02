#!/usr/bin/env node
if (process.stdin.isTTY) process.stdin.setRawMode(true);

let ready = false;
let buffered = "";
let linesOnScreen = 0;

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
  if (buffered.includes("\r") || buffered.includes("\n")) {
    paint(["⏺ Update(a.ts)", "", "✻ Cooking for 1s (esc to interrupt)"]);
    setTimeout(() => {
      paint(["⏺ Update(a.ts)", "", "⏺ Update(b.ts)", "", "✻ Cooking for 2s (esc to interrupt)"]);
    }, 600);
    setTimeout(() => {
      paint(["⏺ Update(a.ts)", "", "⏺ Update(b.ts)", "", "⏺ All done.", "", "> "]);
    }, 1200);
    buffered = "";
  }
});

paint(["Banner", "> "]);
setTimeout(() => {
  ready = true;
}, 300);
setTimeout(() => process.exit(0), 8000);
