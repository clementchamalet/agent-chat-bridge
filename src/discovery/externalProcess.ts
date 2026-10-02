import { execFileSync } from "node:child_process";
import path from "node:path";
import type { Engine } from "../types.js";
import { isPidAlive, readClaudeSessionRegistry } from "./sessionRegistry.js";
import { commandArgs } from "../utils/commandArgs.js";

/** All descendants of `pid` (not just direct children) — used by ownProcessPids to walk a whole process tree. */
function descendantPids(pid: number): number[] {
  const out: number[] = [];
  const seen = new Set([pid]);
  const queue = [pid];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    let raw: string;
    try {
      raw = execFileSync("pgrep", ["-P", String(parent)], { encoding: "utf8" });
    } catch {
      continue; // no children — pgrep exits 1 with no matches
    }
    for (const line of raw.split("\n")) {
      const child = Number(line.trim());
      if (!Number.isSafeInteger(child) || child <= 0 || seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

function ownProcessPids(tmuxSessionName: string): Set<number> {
  let panePid: number | null;
  try {
    const out = execFileSync("tmux", ["list-panes", "-t", tmuxSessionName, "-F", "#{pane_pid}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const pid = Number(out.split("\n")[0]);
    panePid = Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    panePid = null; // session doesn't exist (not live) — nothing of ours to exclude
  }
  if (panePid === null) return new Set();
  return new Set([panePid, ...descendantPids(panePid)]);
}

interface PgrepMatch {
  pid: number;
  command: string;
}

function pgrepMatches(resumeId: string): PgrepMatch[] {
  let out: string;
  try {
    const literalId = resumeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = execFileSync("pgrep", ["-f", "-l", literalId], { encoding: "utf8" });
  } catch {
    return []; // pgrep exits 1 with no matches
  }

  const matches: PgrepMatch[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const spaceIdx = line.indexOf(" ");
    if (spaceIdx === -1) continue;
    const pid = Number(line.slice(0, spaceIdx));
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    matches.push({ pid, command: line.slice(spaceIdx + 1) });
  }
  return matches;
}

export function isOwnTmuxCommand(command: string, ownTmuxSessionName: string): boolean {
  try {
    const [executable, ...args] = commandArgs(command);
    return Boolean(executable && path.basename(executable) === "tmux" && args.includes(ownTmuxSessionName));
  } catch {
    return false;
  }
}

export function findExternalResumeProcesses(engine: Engine, resumeId: string, ownTmuxSessionName: string): number[] {
  if (!resumeId) return [];
  const ownPids = ownProcessPids(ownTmuxSessionName);
  const pids = new Set<number>();

  for (const { pid, command } of pgrepMatches(resumeId)) {
    if (ownPids.has(pid)) continue;
    if (isOwnTmuxCommand(command, ownTmuxSessionName)) continue;
    pids.add(pid);
  }

  if (engine === "claude") {
    const registry = readClaudeSessionRegistry();
    if (registry) {
      for (const entry of registry) {
        if (entry.sessionId !== resumeId) continue;
        if (ownPids.has(entry.pid)) continue;
        if (!isPidAlive(entry.pid)) continue;
        pids.add(entry.pid);
      }
    }
  }

  return [...pids];
}

/** Best-effort SIGTERM — logging failures is the caller's job, this never throws. */
export function killProcess(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return false;
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false; // already gone, or not ours to kill
  }
}

export function getCpuTimeSeconds(pid: number): number | null {
  let out: string;
  try {
    out = execFileSync("ps", ["-o", "time=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null; // process no longer exists
  }
  if (!out) return null;

  // macOS/BSD ps time format: "[[HH:]MM:]SS.ss" — variable number of
  // colon-separated segments depending on how long the process has run.
  const parts = out.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}
