import type { Engine } from "../types.js";
import { config } from "../config.js";

export interface EngineDefinition {
  /** Binary to exec, resolved via PATH. */
  bin: string;
  /** Flags passed in every permission mode. */
  baseArgs: string[];
  modelFlag: string;
  /** Flag that resumes one specific past conversation by id, e.g. "--resume". */
  resumeFlag: string;
  /** Flag for assigning a new conversation ID, when supported. */
  sessionIdFlag?: string;
  /** Flag or subcommand for branching a resumed conversation. */
  forkFlag?: string;
  /** Optional reasoning-effort flag. */
  effortFlag?: string;
}

export const ENGINES: Record<Engine, EngineDefinition> = {
  claude: {
    bin: "claude",
    // --dangerously-skip-permissions auto-approves tool/OS permission
    // prompts while leaving the REPL interactive (no -p/--print flag), so
    // genuine clarification questions still reach the TTY.
    baseArgs: [],
    modelFlag: "--model",
    resumeFlag: "--resume",
    sessionIdFlag: "--session-id",
    forkFlag: "--fork-session",
    effortFlag: "--effort",
  },
  opencode: {
    bin: "opencode",
    baseArgs: [],
    modelFlag: "--model",
    resumeFlag: "--session",
    forkFlag: "--fork",
  },
  codex: {
    bin: "codex",
    baseArgs: ["--no-daemon", "--no-alt-screen", "--sandbox", "workspace-write", "--ask-for-approval", "on-request"],
    modelFlag: "--model",
    resumeFlag: "resume",
    forkFlag: "fork",
  },
};

export function buildSpawnArgs(
  engine: Engine,
  model: string | null,
  options: { resumeId?: string; sessionId?: string; fork?: boolean; effort?: string | null } = {},
): { bin: string; args: string[] } {
  const def = ENGINES[engine];
  const args = [...def.baseArgs];
  if (config.permissionMode === "auto") {
    if (engine === "claude") args.push("--dangerously-skip-permissions");
    if (engine === "opencode") args.push("--auto");
    if (engine === "codex") args[args.indexOf("on-request")] = "never";
  }
  if (engine === "codex") {
    if (model) args.push(def.modelFlag, model);
    if (options.resumeId) args.push(options.fork ? def.forkFlag! : def.resumeFlag, options.resumeId);
    return { bin: def.bin, args };
  }
  if (model) args.push(def.modelFlag, model);
  // Only engines with an effort flag receive this setting.
  if (options.effort && def.effortFlag) args.push(def.effortFlag, options.effort);
  if (options.resumeId) args.push(def.resumeFlag, options.resumeId);
  if (options.sessionId && def.sessionIdFlag) args.push(def.sessionIdFlag, options.sessionId);
  // Fork only makes sense alongside resumeFlag (branching off an existing
  // conversation) — see arbitration flow.
  if (options.fork && options.resumeId && def.forkFlag) args.push(def.forkFlag);
  return { bin: def.bin, args };
}
