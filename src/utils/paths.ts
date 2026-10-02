import os from "node:os";
import path from "node:path";

/** Expands a leading `~` to the current user's home directory. */
export function expandHome(input: string): string {
  if (!input) return input;
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function resolvePath(input: string, base = process.cwd()): string {
  const expanded = expandHome(input);
  return path.isAbsolute(expanded) ? expanded : path.resolve(base, expanded);
}

export function formatProjectLabel(directory: string): string {
  const parts = directory.split(path.sep).filter(Boolean);
  const worktreeIdx = parts.lastIndexOf("worktrees");
  if (worktreeIdx >= 2 && parts[worktreeIdx - 1] === ".claude") {
    const project = parts[worktreeIdx - 2];
    const worktree = parts[parts.length - 1];
    if (project && worktree) return `${project} / ${worktree}`;
  }
  return parts[parts.length - 1] || directory;
}
