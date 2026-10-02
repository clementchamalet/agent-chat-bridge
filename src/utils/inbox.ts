import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const INBOX_ROOT = path.join(os.tmpdir(), "agent-bridge-inbox");
const IMAGE_TTL_MS = 24 * 60 * 60 * 1000;

export function prepareInboxDirectory(jid: string, root = INBOX_ROOT): string {
  if (!jid || jid === "." || jid === ".." || /[/\\]/.test(jid)) throw new Error("Invalid inbox recipient");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(root).isDirectory()) throw new Error("Inbox must be a directory without symbolic links");
  fs.chmodSync(root, 0o700);
  const dir = path.join(root, jid);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory()) throw new Error("Inbox must be a directory without symbolic links");
  fs.chmodSync(dir, 0o700);
  return dir;
}

export function pruneExpiredFiles(dir: string, now = Date.now()): number {
  if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory()) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile() && now - stat.mtimeMs > IMAGE_TTL_MS) {
        fs.unlinkSync(file);
        removed++;
      }
    } catch {
      // A concurrent cleanup may remove the file first.
    }
  }
  return removed;
}

export function pruneExpiredImages(root = INBOX_ROOT, now = Date.now()): number {
  if (!fs.existsSync(root) || !fs.lstatSync(root).isDirectory()) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    try {
      removed += pruneExpiredFiles(dir, now);
    } catch {
      // Ignore directories removed or made unreadable during cleanup.
    }
  }
  return removed;
}
