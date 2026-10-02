export interface CommandDef {
  name: string;
  usage: string;
  description: string;
}

export const COMMAND_DEFS: CommandDef[] = [
  {
    name: "new",
    usage: "/new [claude|opencode|codex] [model|--model name] [effort] [path]",
    description: "Start a new conversation",
  },
  {
    name: "sessions",
    usage: "/sessions [filter] [--all]",
    description: "List and select conversations",
  },
  {
    name: "repo",
    usage: "/repo [filter]",
    description: "Switch the working directory",
  },
  { name: "file", usage: "/file [name]", description: "Send a file from the current directory" },
  { name: "stop", usage: "/stop", description: "Interrupt the current turn" },
  { name: "kill", usage: "/kill", description: "Stop the agent process" },
  { name: "diff", usage: "/diff", description: "Show uncommitted changes" },
  { name: "commit", usage: "/commit <message>", description: "Commit and push changes" },
  { name: "status", usage: "/status", description: "Show session status" },
  {
    name: "usage",
    usage: "/usage",
    description: "Show available usage for supported providers",
  },
  { name: "screen", usage: "/screen", description: "Show the raw tmux screen" },
  { name: "discard", usage: "/discard", description: "Clear queued input" },
  { name: "mac", usage: "/mac", description: "Show the command to attach from this Mac" },
  {
    name: "verbose",
    usage: "/verbose [on|off]",
    description: "Toggle progress messages during long tasks",
  },
  { name: "help", usage: "/help", description: "Show available commands" },
];

export const HELP = [
  "Available commands:",
  ...COMMAND_DEFS.map((c) => `${c.usage} — ${c.description}`),
  "",
  "Other slash commands go directly to the active agent, just as in a terminal.",
].join("\n");
