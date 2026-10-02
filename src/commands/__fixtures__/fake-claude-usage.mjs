#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "-p" && args[1] === "/usage") {
  console.log(
    [
      "You are currently using your subscription to power your Claude Code usage",
      "",
      "Current session: 25% used · resets Jan 1 at 12pm (UTC)",
      "Current week (all models): 50% used · resets Jan 2 at 12pm (UTC)",
      "",
      "What's contributing to your limits usage?",
      "Approximate, based on local sessions on this machine.",
    ].join("\n"),
  );
  process.exit(0);
}
process.exit(1);
