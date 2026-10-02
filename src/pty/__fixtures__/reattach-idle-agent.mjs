#!/usr/bin/env node
if (process.stdin.isTTY) process.stdin.setRawMode(true);

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
  buffered += chunk;
  if (buffered.includes("\r") || buffered.includes("\n")) {
    const line = buffered.replace(/[\r\n]+$/, "");
    paint([`got: ${line}`, "", "> "]);
    buffered = "";
  }
});

paint(["Banner", "", "> "]);
setTimeout(() => process.exit(0), 15000);
