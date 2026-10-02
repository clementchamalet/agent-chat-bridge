import { execFileSync } from "node:child_process";
import { openDatabase } from "./db/database.js";
import { pruneExpiredImages } from "./utils/inbox.js";

const days = Number(process.argv[2] ?? "30");
if (!Number.isInteger(days) || days < 1) throw new Error("Usage: npm run prune -- <days>");
execFileSync("tmux", ["-V"], { stdio: "ignore" });

const db = openDatabase();
try {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = db
    .prepare("SELECT jid, tmuxSession FROM sessions WHERE state = 'IDLE' AND updatedAt < ?")
    .all(cutoff) as { jid: string; tmuxSession: string }[];
  let removed = 0;
  for (const row of rows) {
    try {
      execFileSync("tmux", ["has-session", "-t", row.tmuxSession], { stdio: "ignore" });
    } catch {
      const result = db
        .prepare("DELETE FROM sessions WHERE jid = ? AND state = 'IDLE' AND updatedAt < ?")
        .run(row.jid, cutoff);
      removed += result.changes;
    }
  }
  const images = pruneExpiredImages();
  console.log(`Removed ${removed} idle session record(s) older than ${days} days and ${images} expired image(s).`);
} finally {
  db.close();
}
