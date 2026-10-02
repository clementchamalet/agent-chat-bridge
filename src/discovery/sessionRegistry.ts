import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ClaudeSessionRegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string;
}

/** True if a process with this pid currently exists — signal 0 sends nothing, just probes. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readClaudeSessionRegistry(
  dir = path.join(os.homedir(), ".claude", "sessions"),
): ClaudeSessionRegistryEntry[] | null {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return null; // directory absent/unreadable — signal a full fallback to pgrep
  }

  const entries: ClaudeSessionRegistryEntry[] = [];
  for (const file of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, file), "utf8");
    } catch {
      continue; // vanished between readdir and read — skip, not fatal
    }

    let record: unknown;
    try {
      record = JSON.parse(raw);
    } catch {
      continue;
    }

    if (!record || typeof record !== "object") continue;
    const { pid, sessionId, cwd } = record as Record<string, unknown>;
    if (
      typeof pid !== "number" ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      typeof sessionId !== "string" ||
      typeof cwd !== "string"
    )
      continue;
    entries.push({ pid, sessionId, cwd });
  }
  return entries;
}
