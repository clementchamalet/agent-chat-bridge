import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Engine } from "../types.js";

const BRIDGE_PREFIX = "wa-"; // Preserves existing tmux session names across upgrades.

/** Sanitizes an arbitrary label into a safe tmux session-name component (alphanumeric, `_`, `-`). */
export function sanitizeSessionLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function liveSessionName(engine: Engine, resumeId: string): string {
  return `${BRIDGE_PREFIX}${engine}-${sanitizeSessionLabel(resumeId)}`;
}

export function placeholderSessionName(engine: Engine, jid: string): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${BRIDGE_PREFIX}${engine}-pending-${sanitizeSessionLabel(jid)}-${Date.now()}-${random}`;
}

/** True for any tmux session this bridge could have created (either naming form above). */
export function isBridgeSessionName(name: string): boolean {
  return /^wa-(?:claude|opencode|codex)-[a-zA-Z0-9_-]+$/.test(name);
}

export interface BootstrapIdentity {
  /** Null for OpenCode and Codex until their conversation is discovered. */
  resumeId: string | null;
  tmuxSession: string;
}

export function bootstrapIdentity(engine: Engine, jid: string): BootstrapIdentity {
  if (engine === "claude") {
    const resumeId = randomUUID();
    return { resumeId, tmuxSession: liveSessionName(engine, resumeId) };
  }
  return { resumeId: null, tmuxSession: placeholderSessionName(engine, jid) };
}

export function capturePane(tmuxSession: string): string | null {
  try {
    return execFileSync("tmux", ["capture-pane", "-p", "-t", tmuxSession], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).replace(/\s+$/, "");
  } catch {
    return null;
  }
}
