import type { SessionRecord } from "../types.js";
import { COMMAND_DEFS, HELP } from "./definitions.js";
import type { CommandContext } from "./context.js";
import {
  cmdCommit,
  cmdDiff,
  cmdFile,
  cmdHelp,
  cmdKill,
  cmdMac,
  cmdNew,
  cmdDiscard,
  cmdRepo,
  cmdScreen,
  cmdSessions,
  cmdStatus,
  cmdStop,
  cmdUsage,
  cmdVerbose,
  type CommandHandler,
} from "./handlers.js";

export { HELP };

const COMMANDS: Record<string, CommandHandler> = {
  new: cmdNew,
  sessions: cmdSessions,
  repo: cmdRepo,
  file: cmdFile,
  stop: cmdStop,
  kill: cmdKill,
  diff: cmdDiff,
  commit: cmdCommit,
  status: cmdStatus,
  usage: cmdUsage,
  screen: cmdScreen,
  discard: cmdDiscard,
  mac: cmdMac,
  verbose: cmdVerbose,
  help: cmdHelp,
};

const CONTROL_COMMANDS = new Set(["stop", "kill"]);

const PASSIVE_COMMANDS = new Set(["verbose", "status", "usage", "screen", "mac", "file", "diff", "help", "discard"]);

export function parseCommand(text: string): { name: string; args: string } | null {
  const match = text.trim().match(/^\/(\S+)\s*([\s\S]*)$/);
  if (!match) return null;
  return { name: match[1]!.toLowerCase(), args: match[2]!.trim() };
}

export function isBridgeCommand(text: string): boolean {
  const parsed = parseCommand(text);
  return parsed !== null && Object.hasOwn(COMMANDS, parsed.name);
}

/** Process-control commands remain available in every session state. */
export function isControlCommand(text: string): boolean {
  const parsed = parseCommand(text);
  return parsed !== null && CONTROL_COMMANDS.has(parsed.name);
}

/** Commands that can run without waiting for an idle agent. */
export function isPassiveCommand(text: string): boolean {
  const parsed = parseCommand(text);
  return parsed !== null && PASSIVE_COMMANDS.has(parsed.name);
}

export async function routeCommand(
  ctx: CommandContext,
  jid: string,
  session: SessionRecord,
  text: string,
): Promise<void> {
  const parsed = parseCommand(text);
  if (!parsed) return;
  const handler = COMMANDS[parsed.name];
  if (!Object.hasOwn(COMMANDS, parsed.name) || !handler) return;
  await handler(ctx, jid, session, parsed.args);
}

export { COMMAND_DEFS };
