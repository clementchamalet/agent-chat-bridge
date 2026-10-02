import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { simpleGit } from "simple-git";
import { config } from "../config.js";
import { HELP } from "./definitions.js";
import { discoverSessions } from "../discovery/sessions.js";
import { ENGINES } from "../pty/engines.js";
import { bootstrapIdentity, capturePane } from "../pty/tmux.js";
import { formatProjectLabel, resolvePath } from "../utils/paths.js";
import { codeFence } from "../utils/chunk.js";
import { findFiles } from "../utils/findFiles.js";
import { formatRelativeAge } from "../utils/time.js";
import { isSensitivePath } from "../utils/sensitivePath.js";
import { commandArgs } from "../utils/commandArgs.js";
import { VALID_ENGINES, type Engine, type SessionRecord } from "../types.js";
import type { CommandContext } from "./context.js";

export type CommandHandler = (ctx: CommandContext, jid: string, session: SessionRecord, args: string) => Promise<void>;

const PATH_PREFIX = /^(\/|~|\.\/|\.\.\/)/;

const EFFORT_LEVELS = new Map([
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["xhigh", "xhigh"],
  ["extra", "xhigh"],
  ["extrahigh", "xhigh"],
  ["max", "max"],
]);

function listProjectRootChildren(): string[] {
  const out: string[] = [];
  for (const root of config.projectSearchRoots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) out.push(path.join(root, entry.name));
    }
  }
  return out;
}

function knownRepoDirectories(filterText = ""): string[] {
  const seen = new Set<string>();
  for (const s of discoverSessions()) seen.add(s.directory);
  for (const d of listProjectRootChildren().sort()) seen.add(d);
  const dirs = [...seen];
  if (!filterText) return dirs;
  const lower = filterText.toLowerCase();
  return dirs.filter((d) => formatProjectLabel(d).toLowerCase().includes(lower) || d.toLowerCase().includes(lower));
}

function matchKnownRepo(word: string, directories: string[]): string | null {
  const lower = word.toLowerCase();
  const exact = directories.filter((d) => path.basename(d).toLowerCase() === lower);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return null;
  const partial = directories.filter((d) => path.basename(d).toLowerCase().includes(lower));
  return partial.length === 1 ? partial[0]! : null;
}

// Recognized model names and aliases; other names require --model.
const MODEL_TOKEN =
  /^(?:sonnet|opus|haiku|default|opusplan)(?:\[[^\]]+\])?$|^(?:claude-|gpt-|o\d(?:-|$))|^[\w.-]+\/[\w.:-]+$/i;
// A bare word that's safe to turn into a new folder name.
const NEW_FOLDER_NAME = /^[\w][\w.-]*$/;

function parseNewArgs(
  args: string,
  session: SessionRecord,
): {
  engine: Engine;
  model: string | null;
  effort: string | null;
  directory: string;
  create: boolean;
  ambiguous: { word: string; candidates: string[] } | null;
} {
  const tokens = commandArgs(args);
  const engineTokens = tokens.filter(
    (token, index) =>
      tokens[index - 1]?.toLowerCase() !== "--model" &&
      (VALID_ENGINES as readonly string[]).includes(token.toLowerCase()),
  );
  if (engineTokens.length > 1) throw new Error("Choose one engine for /new");
  const selectedEngine = engineTokens[0];
  let engine: Engine = selectedEngine ? (selectedEngine.toLowerCase() as Engine) : session.engine;
  let directory = session.workingDir;
  let effort: string | null = engine === session.engine ? session.effort : null;
  let create = false;
  let ambiguous: { word: string; candidates: string[] } | null = null;
  const modelTokens: string[] = [];
  let knownDirs: string[] | null = null; // fetched lazily — only /new calls with a bare word actually need it

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const lower = token.toLowerCase();
    if (lower === "--model") {
      const model = tokens[++index];
      if (!model || model.startsWith("--")) throw new Error("--model requires a model name");
      modelTokens.push(model);
    } else if (token.startsWith("--")) {
      throw new Error(`Unknown /new option: ${token}`);
    } else if ((VALID_ENGINES as readonly string[]).includes(lower)) {
      engine = lower as Engine;
    } else if (PATH_PREFIX.test(token)) {
      // "./x" and "../x" are relative to the conversation's own folder —
      // not to wherever the bridge process happens to run from.
      directory = resolvePath(token, session.workingDir);
      create = true;
    } else if (EFFORT_LEVELS.has(lower)) {
      effort = EFFORT_LEVELS.get(lower)!;
    } else if (MODEL_TOKEN.test(token)) {
      modelTokens.push(token);
    } else {
      knownDirs ??= knownRepoDirectories();
      const repoMatch = matchKnownRepo(token, knownDirs);
      const candidates = repoMatch ? [] : knownDirs.filter((d) => path.basename(d).toLowerCase().includes(lower));
      if (repoMatch) {
        directory = repoMatch;
      } else if (candidates.length > 1) {
        // Several known folders fit — never guess, and never create a third.
        ambiguous = { word: token, candidates };
      } else if (NEW_FOLDER_NAME.test(token)) {
        directory = path.join(config.workspacesRoot, token);
        create = true;
      } else {
        modelTokens.push(token);
      }
    }
  }

  if (modelTokens.length > 1) throw new Error("Choose one model for /new");
  return {
    engine,
    directory,
    effort,
    create,
    ambiguous,
    model: modelTokens.length > 0 ? modelTokens.join(" ") : engine === session.engine ? session.model : null,
  };
}

export async function startFreshSession(
  ctx: CommandContext,
  jid: string,
  engine: Engine,
  model: string | null,
  effort: string | null,
  directory: string,
  options: { create?: boolean } = {},
): Promise<void> {
  let exists = false;
  let isDir = false;
  try {
    const stat = fs.statSync(directory);
    exists = true;
    isDir = stat.isDirectory();
  } catch {
    exists = false;
  }
  let created = false;
  if (!exists && options.create && fs.existsSync(path.dirname(directory))) {
    try {
      fs.mkdirSync(directory);
      isDir = true;
      created = true;
    } catch (err) {
      await ctx.sender.sendText(
        jid,
        `❌ Could not create \`${directory}\`: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
  }
  if (!isDir) {
    await ctx.sender.sendText(
      jid,
      exists
        ? `❌ \`${directory}\` is not a directory.`
        : `❌ Directory not found: \`${directory}\` (its parent does not exist).`,
    );
    return;
  }

  if (ctx.ptyManager.isAlive(jid)) await ctx.ptyManager.detach(jid);

  const identity = bootstrapIdentity(engine, jid);
  ctx.sessionRepo.update(jid, {
    engine,
    model,
    effort,
    workingDir: directory,
    tmuxSession: identity.tmuxSession,
    resumeId: identity.resumeId,
    title: null,
    started: false,
    ptyPid: null,
    state: "IDLE",
    waitingSince: null,
    // A new conversation has no resolved model label yet.
    resolvedModel: null,
  });

  await ctx.sender.sendText(
    jid,
    `${created ? "📁 Directory created.\n" : ""}🆕 ${engine} · ${model ?? "default model"}${effort ? ` · effort ${effort}` : ""} · \`${directory}\`\nSend a message to start.`,
  );
}

export const cmdNew: CommandHandler = async (ctx, jid, session, args) => {
  let parsed: ReturnType<typeof parseNewArgs>;
  try {
    parsed = parseNewArgs(args, session);
  } catch (err) {
    await ctx.sender.sendText(jid, `❌ ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const { engine, model, effort, directory, create, ambiguous } = parsed;
  if (ambiguous) {
    const list = ambiguous.candidates.map((d) => `- ${formatProjectLabel(d)}`).join("\n");
    await ctx.sender.sendText(
      jid,
      `Several directories match "${ambiguous.word}":\n${list}\n\nSpecify the name or choose one with /repo ${ambiguous.word}.`,
    );
    return;
  }
  await startFreshSession(ctx, jid, engine, model, effort, directory, { create });
};

export const cmdRepo: CommandHandler = async (ctx, jid, _session, args) => {
  const filterText = args.trim();
  const dirs = knownRepoDirectories(filterText);

  if (dirs.length === 0) {
    await ctx.sender.sendText(
      jid,
      filterText ? `No directory matches "${filterText}".` : "No known directories yet. Use /new <path> to start one.",
    );
    return;
  }

  ctx.repoPicker.show(jid, dirs, (page) => {
    const lines = page.items.map((d, i) => `${page.startNumber + i}. ${formatProjectLabel(d)}`);
    if (page.more) lines.push(`${page.more.number}. ▶ More (${page.more.remaining} remaining)`);
    return `${lines.join("\n")}\n\nReply with a number to switch.`;
  });
  await ctx.sender.sendText(jid, ctx.repoPicker.renderPage(jid)!);
};

// Default filters for inactive conversations; /sessions --all bypasses them.
const HIDE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const HIDE_MIN_SIZE_BYTES = 2048;

export const cmdSessions: CommandHandler = async (ctx, jid, session, args) => {
  const showAll = /(^|\s)--all(\s|$)/.test(` ${args} `);
  const filterText = args.replace(/--all/g, "").trim().toLowerCase();

  const discovered = discoverSessions();
  let list = discovered;

  if (!showAll) {
    const cutoff = Date.now() - HIDE_MAX_AGE_MS;
    list = list.filter(
      (s) => s.live || (s.updatedAt >= cutoff && (s.sizeBytes === undefined || s.sizeBytes >= HIDE_MIN_SIZE_BYTES)),
    );
  }

  if (filterText) {
    list = list.filter(
      (s) => s.title.toLowerCase().includes(filterText) || s.directory.toLowerCase().includes(filterText),
    );
  }

  if (list.length === 0) {
    await ctx.sender.sendText(
      jid,
      filterText
        ? `No session matches "${filterText}".`
        : discovered.length > 0
          ? "No recent sessions. Use /sessions --all to see everything."
          : "No sessions found. Send a message or use /new to start one.",
    );
    return;
  }

  ctx.sessionPicker.show(jid, list, (page) => {
    const groups = new Map<string, { s: (typeof page.items)[number]; num: number }[]>();
    page.items.forEach((s, i) => {
      const label = formatProjectLabel(s.directory);
      const entries = groups.get(label) ?? [];
      entries.push({ s, num: page.startNumber + i });
      groups.set(label, entries);
    });

    const lines: string[] = [];
    for (const [project, entries] of groups) {
      lines.push(`*${project}*`);
      for (const { s, num } of entries) {
        const marker = s.tmuxSession === session.tmuxSession ? "❯" : s.activeElsewhere ? "⚠️" : s.live ? "🟢" : "⚪";
        lines.push(`${num}. ${marker} [${s.engine}] ${s.title} (${formatRelativeAge(s.updatedAt)})`);
      }
    }
    if (page.more) lines.push(`${page.more.number}. ▶ More (${page.more.remaining} remaining)`);

    const hint = list.some((s) => s.activeElsewhere) ? "\n\n⚠️ = already open elsewhere (desktop app or terminal)." : "";
    const hiddenNote =
      !showAll && list.length < discovered.length
        ? "\n\nUse /sessions --all to include sessions older than 7 days or very short sessions."
        : "";
    return `${lines.join("\n")}${hint}${hiddenNote}\n\nReply with a number (or #3 later) to switch.`;
  });

  await ctx.sender.sendText(jid, ctx.sessionPicker.renderPage(jid)!);
};

export const cmdFile: CommandHandler = async (ctx, jid, session, args) => {
  const query = args.trim();
  const matches = await findFiles(session.workingDir, query, 300);

  if (matches.length === 0) {
    await ctx.sender.sendText(
      jid,
      query
        ? `No file matches "${query}" in \`${session.workingDir}\`.`
        : `No files found in \`${session.workingDir}\`.`,
    );
    return;
  }

  if (matches.length === 1 && query) {
    await ctx.sender.sendDocument(jid, matches[0]!);
    return;
  }

  ctx.filePicker.show(jid, matches, (page) => {
    const lines = page.items.map(
      (absPath, i) => `${page.startNumber + i}. ${path.relative(session.workingDir, absPath)}`,
    );
    if (page.more) lines.push(`${page.more.number}. ▶ More (${page.more.remaining} remaining)`);
    return `${lines.join("\n")}\n\nReply with a number to receive the file.`;
  });
  await ctx.sender.sendText(jid, ctx.filePicker.renderPage(jid)!);
};

export const cmdVerbose: CommandHandler = async (ctx, jid, session, args) => {
  const arg = args.trim().toLowerCase();
  if (arg && arg !== "on" && arg !== "off") {
    await ctx.sender.sendText(jid, "Usage: /verbose [on|off]");
    return;
  }
  const next = arg === "on" ? true : arg === "off" ? false : !session.verbose;

  ctx.sessionRepo.update(jid, { verbose: next });
  await ctx.sender.sendText(
    jid,
    next
      ? "🔊 Progress updates enabled for long tasks."
      : "🔈 Progress updates disabled; only final replies and questions will be sent.",
  );
};

export const cmdStatus: CommandHandler = async (ctx, jid, session) => {
  const load = os.loadavg();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const pid = ctx.ptyManager.getPid(jid);

  const lines = [
    `channel:  ${jid.startsWith("tg:") ? "Telegram" : "WhatsApp"}`,
    `engine:   ${session.engine}`,
    `session:  ${session.resumeId ?? "(new)"}`,
    `model:    ${session.model ?? "(default)"}`,
    `folder:   ${session.workingDir}`,
    `state:    ${session.state}`,
    `process:  ${pid ? `active (pid ${pid})` : "inactive"}`,
    `tmux:     ${session.tmuxSession}`,
    `database: ${config.dbPath}`,
    `verbose:  ${session.verbose ? "enabled" : "disabled"}`,
    ``,
    `cpus:     ${os.cpus().length}`,
    `load:     ${load.map((n) => n.toFixed(2)).join(", ")}`,
    `memory:   ${((totalMem - freeMem) / 1024 / 1024 / 1024).toFixed(1)}GB / ${(totalMem / 1024 / 1024 / 1024).toFixed(1)}GB`,
  ];

  await ctx.sender.sendText(jid, codeFence(lines.join("\n")));
};

const execFileAsync = promisify(execFile);

const USAGE_LINE = /^Current (?:session|week)\b.*$/gm;

function stripUsageNoise(line: string): string {
  return line.replace(/\s*\(all models\)/i, "").replace(/\s*\([^()]*\)\s*$/, "");
}

async function sendClaudeUsage(ctx: CommandContext, jid: string): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(ENGINES.claude.bin, ["-p", "/usage"], {
      cwd: os.tmpdir(),
      timeout: 45_000,
    }));
  } catch (err) {
    await ctx.sender.sendText(jid, `❌ Could not retrieve usage: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const lines = stdout.match(USAGE_LINE);
  await ctx.sender.sendText(
    jid,
    lines && lines.length > 0 ? lines.map(stripUsageNoise).join("\n") : stdout.trim() || "No usage data received.",
  );
}

const OPENCODE_AUTH_PATH = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");

interface DeepseekBalanceResponse {
  is_available: boolean;
  balance_infos: { currency: string; total_balance: string }[];
}

async function fetchDeepseekBalance(): Promise<string> {
  let key: string | undefined;
  try {
    const auth = JSON.parse(fs.readFileSync(OPENCODE_AUTH_PATH, "utf8"));
    key = auth?.deepseek?.key;
  } catch {
    // fall through — treated the same as "no key configured" below
  }
  if (!key) {
    throw new Error(`DeepSeek key not found in ${OPENCODE_AUTH_PATH}; run \`opencode auth login\``);
  }

  const res = await fetch("https://api.deepseek.com/user/balance", {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`DeepSeek returned HTTP ${res.status}`);

  const data = (await res.json()) as DeepseekBalanceResponse;
  const balances = data.balance_infos.map((b) => `${b.total_balance} ${b.currency}`).join(", ");
  return `💳 DeepSeek balance: ${balances}${data.is_available ? "" : " (account depleted)"}`;
}

export const cmdUsage: CommandHandler = async (ctx, jid, session) => {
  if (session.engine === "opencode") {
    const provider = session.model?.split("/")[0]?.toLowerCase();
    if (provider === "deepseek") {
      try {
        await ctx.sender.sendText(jid, await fetchDeepseekBalance());
      } catch (err) {
        await ctx.sender.sendText(
          jid,
          `❌ Could not retrieve DeepSeek balance: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }
    await ctx.sender.sendText(
      jid,
      `ℹ️ Usage is unavailable for this provider${provider ? ` (${provider})` : ""}. Only DeepSeek balance is supported here.`,
    );
    return;
  }

  if (session.engine === "codex") {
    await ctx.sender.sendText(
      jid,
      "ℹ️ Codex usage is not available through this bridge. Check your Codex account directly.",
    );
  } else {
    await sendClaudeUsage(ctx, jid);
  }
};

export const cmdDiff: CommandHandler = async (ctx, jid, session) => {
  const git = simpleGit({ baseDir: session.workingDir });
  if (!(await git.checkIsRepo())) {
    await ctx.sender.sendText(jid, `❌ \`${session.workingDir}\` is not a Git repository.`);
    return;
  }

  const status = await git.status();
  if (status.files.some((file) => isSensitivePath(file.path) || (file.from && isSensitivePath(file.from)))) {
    await ctx.sender.sendText(jid, "❌ Diff blocked: sensitive paths are present in the working tree.");
    return;
  }
  const [unstaged, staged] = await Promise.all([git.diff(), git.diff(["--cached"])]);
  const diffText = [unstaged, staged].filter(Boolean).join("\n");
  const untracked = status.not_added.length > 0 ? `\n\nUntracked files:\n${status.not_added.join("\n")}` : "";
  const full = `${diffText}${untracked}`.trim();

  if (!full) {
    await ctx.sender.sendText(jid, "✅ No uncommitted changes.");
    return;
  }

  if (full.length <= 3000) {
    await ctx.sender.sendText(jid, codeFence(full));
    return;
  }

  const tmpFile = path.join(os.tmpdir(), `bridge-diff-${randomUUID()}.patch`);
  fs.writeFileSync(tmpFile, full, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await ctx.sender.sendDocument(jid, tmpFile, "changes.patch");
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
};

export const cmdCommit: CommandHandler = async (ctx, jid, session, args) => {
  const message = args.trim();
  if (!message) {
    await ctx.sender.sendText(jid, "Usage: /commit <message>");
    return;
  }

  const git = simpleGit({ baseDir: session.workingDir });
  if (!(await git.checkIsRepo())) {
    await ctx.sender.sendText(jid, `❌ \`${session.workingDir}\` is not a Git repository.`);
    return;
  }

  const status = await git.status();
  const sensitive = status.files
    .flatMap((file) => (file.from ? [file.path, file.from] : [file.path]))
    .filter(isSensitivePath);
  if (sensitive.length > 0) {
    await ctx.sender.sendText(jid, `❌ Commit blocked: sensitive paths are present (${sensitive.join(", ")}).`);
    return;
  }

  try {
    await ctx.sender.sendText(jid, `Committing and pushing changes in \`${session.workingDir}\` (${session.engine}).`);
    await git.add(["-A"]);
    const commitResult = await git.commit(message);
    if (commitResult.commit) {
      await ctx.sender.sendText(jid, `✅ Commit \`${commitResult.commit}\`. Pushing…`);
    } else {
      await ctx.sender.sendText(jid, "ℹ️ Nothing to commit.");
      return;
    }
    await git.push();
    await ctx.sender.sendText(jid, "🚀 Pushed.");
  } catch (err) {
    await ctx.sender.sendText(jid, `❌ Commit or push failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};

export const cmdStop: CommandHandler = async (ctx, jid) => {
  if (!ctx.ptyManager.isAlive(jid)) {
    await ctx.sender.sendText(jid, "Nothing is running.");
    return;
  }
  ctx.ptyManager.interrupt(jid);
  await ctx.sender.sendText(jid, "⏸️ Interrupt sent.");
};

/** Stop the agent process. */
export const cmdKill: CommandHandler = async (ctx, jid) => {
  const wasAlive = ctx.ptyManager.isAlive(jid);
  if (wasAlive) ctx.ptyManager.kill(jid);
  ctx.sessionRepo.update(jid, { state: "IDLE", ptyPid: null, waitingSince: null });
  await ctx.sender.sendText(jid, wasAlive ? "🛑 Process stopped." : "Nothing was running.");
};

export const cmdScreen: CommandHandler = async (ctx, jid, session) => {
  const screen = capturePane(session.tmuxSession);
  if (screen === null) {
    await ctx.sender.sendText(jid, "Nothing is running.");
    return;
  }
  await ctx.sender.sendText(jid, codeFence(screen || "(empty screen)"));
};

export const cmdDiscard: CommandHandler = async (ctx, jid) => {
  const cancelled = ctx.ptyManager.cancelPendingInitial(jid);
  await ctx.sender.sendText(jid, cancelled ? "🗑️ Queued message discarded." : "No message was queued.");
};

export const cmdMac: CommandHandler = async (ctx, jid, session) => {
  if (!ctx.ptyManager.isAlive(jid)) {
    await ctx.sender.sendText(jid, "Nothing is running. Send a message to start a session, then use /mac.");
    return;
  }
  await ctx.sender.sendText(
    jid,
    `🖥️ On this Mac:\n\n${codeFence(`tmux attach -t ${session.tmuxSession}`)}\nThis attaches to the same process.`,
  );
};

export const cmdHelp: CommandHandler = async (ctx, jid) => {
  await ctx.sender.sendText(jid, HELP);
};
