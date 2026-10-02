#!/usr/bin/env node
if (process.stdin.isTTY) process.stdin.setRawMode(true);

const options = ["No, exit", "Yes, I trust this folder"];
let cursor = 0;
let trusted = false;
let buffered = "";
let linesOnScreen = 0;

function paint(lines) {
  let out = "";
  for (let i = 0; i < linesOnScreen; i++) out += "\x1b[1A\x1b[2K";
  out += lines.join("\n") + "\n";
  process.stdout.write(out);
  linesOnScreen = lines.length;
}

function dialog() {
  return [
    " Accessing workspace:",
    "",
    " /tmp/some/brand-new/project",
    "",
    " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source",
    " project, or work from your team). If not, take a moment to review what's in this folder first.",
    "",
    ...options.map((o, i) => (i === cursor ? ` ❯ ${o}` : `   ${o}`)),
    "",
    " Enter to confirm · Esc to cancel",
  ];
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (!trusted) {
    if (chunk === "\x1b[A") cursor = Math.max(0, cursor - 1);
    else if (chunk === "\x1b[B") cursor = Math.min(options.length - 1, cursor + 1);
    else if (chunk === "\r" || chunk === "\n") {
      if (cursor === 0) process.exit(1);
      trusted = true;
      paint(["Welcome", "", "❯ "]);
      return;
    }
    paint(dialog());
    return;
  }
  buffered += chunk;
  if (buffered.includes("\r") || buffered.includes("\n")) {
    const line = buffered.replace(/[\r\n]+$/, "");
    buffered = "";
    paint([`RECEIVED: ${line}`, "", "❯ "]);
  }
});

paint(dialog());
setTimeout(() => process.exit(0), 8000);
