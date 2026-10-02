#!/usr/bin/env node
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
    const line = buffered.replace(/[\r\n]+$/, "");
    paint([`got: ${line}`, "DONE_MARKER", "> "]);
    buffered = "";
  }
});

paint(["Banner", "> "]);

setTimeout(() => paint(["Banner", "connecting...", "> "]), 600);
setTimeout(() => paint(["Banner", "> "]), 1200);
setTimeout(() => {
  ready = true;
}, 1500);

setTimeout(() => process.exit(0), 8000);
