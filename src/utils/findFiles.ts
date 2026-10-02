import fs from "node:fs/promises";
import path from "node:path";
import { isSensitivePath } from "./sensitivePath.js";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".cache",
  ".codex",
  ".claude",
  ".ssh",
  "data",
]);

const MAX_SCAN_FILES = 20_000;

interface Candidate {
  absPath: string;
  mtimeMs: number;
}

async function walk(dir: string, out: Candidate[]): Promise<void> {
  if (out.length >= MAX_SCAN_FILES) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // Directory vanished, unreadable, or doesn't exist — skip it.
  }

  for (const entry of entries) {
    if (out.length >= MAX_SCAN_FILES) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
      await walk(full, out);
    } else if (entry.isFile()) {
      if (isSensitivePath(full)) continue;
      try {
        const stat = await fs.stat(full);
        out.push({ absPath: full, mtimeMs: stat.mtimeMs });
      } catch {
        // File disappeared mid-scan — ignore.
      }
    }
  }
}

export async function findFiles(dir: string, query: string, limit = 12): Promise<string[]> {
  const candidates: Candidate[] = [];
  await walk(dir, candidates);

  const needle = query.trim().toLowerCase();
  const matches = needle
    ? candidates.filter((c) => path.relative(dir, c.absPath).toLowerCase().includes(needle))
    : candidates;

  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches.slice(0, limit).map((c) => c.absPath);
}
