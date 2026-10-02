#!/usr/bin/env node
if (process.stdin.isTTY) process.stdin.setRawMode(true);

let linesOnScreen = 0;
function paint(lines) {
  let out = "";
  for (let i = 0; i < linesOnScreen; i++) out += "\x1b[1A\x1b[2K";
  out += lines.join("\n") + "\n";
  process.stdout.write(out);
  linesOnScreen = lines.length;
}

paint(["⏺ Update(a.ts)", "", "✻ Cooking for 1s (esc to interrupt)"]);
setTimeout(() => {
  paint(["⏺ Update(a.ts)", "", "⏺ All done.", "", "> "]);
}, 800);
setTimeout(() => process.exit(0), 8000);
