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

  if (chunk.includes("\r")) {
    const beforeCr = chunk.slice(0, chunk.indexOf("\r"));
    if (beforeCr.length > 0) {
      buffered += beforeCr;
      paint([`❯ ${buffered}`]);
      return;
    }
    paint([`got: ${buffered}`, "DONE_MARKER", "❯"]);
    buffered = "";
    return;
  }

  buffered += chunk;
  paint([`❯ ${buffered}`]);
});

paint(["Banner", "❯"]);
setTimeout(() => {
  ready = true;
}, 300);
setTimeout(() => process.exit(0), 8000);
