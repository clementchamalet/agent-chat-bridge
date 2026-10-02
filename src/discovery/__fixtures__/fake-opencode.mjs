#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "session" && args[1] === "list") {
  console.log(
    JSON.stringify([
      { id: "ses_abc123", title: "Fake opencode session", updated: 1700000000000, directory: "/tmp/fake-project" },
    ]),
  );
  process.exit(0);
}
process.exit(1);
