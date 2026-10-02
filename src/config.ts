import fs from "node:fs";
import { resolvePath } from "./utils/paths.js";
import type { Engine } from "./types.js";
import type { LogLevel } from "./utils/logger.js";

if (process.env.NODE_ENV !== "test" && fs.existsSync(".env")) process.loadEnvFile(".env");

function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

function normalizeNumber(raw: string): string {
  // Normalize international numbers to the Cloud API's digits-only format.
  return raw.replace(/[^\d]/g, "");
}

const allowedNumbersRaw = env("ALLOWED_NUMBERS");
const allowedNumbers = new Set(
  allowedNumbersRaw
    .split(",")
    .map((n) => normalizeNumber(n))
    .filter((n) => n.length > 0),
);

const engine = env("DEFAULT_ENGINE", "claude") as Engine;
if (engine !== "claude" && engine !== "opencode" && engine !== "codex") {
  throw new Error(`DEFAULT_ENGINE must be "claude", "opencode", or "codex", got "${engine}"`);
}

const whatsappAccessToken = env("WHATSAPP_ACCESS_TOKEN");
const whatsappPhoneNumberId = env("WHATSAPP_PHONE_NUMBER_ID");
const whatsappVerifyToken = env("WHATSAPP_VERIFY_TOKEN");
const whatsappAppSecret = env("WHATSAPP_APP_SECRET");
const telegramToken = env("TELEGRAM_BOT_TOKEN");
const telegramAllowedUsers = new Set(
  env("TELEGRAM_ALLOWED_USER_IDS")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);
const whatsappEnabled = Boolean(
  whatsappAccessToken || whatsappPhoneNumberId || whatsappVerifyToken || whatsappAppSecret,
);

const permissionMode = env("AGENT_PERMISSION_MODE", "review");
if (permissionMode !== "review" && permissionMode !== "auto") {
  throw new Error("AGENT_PERMISSION_MODE must be review or auto");
}

export const config = {
  allowedNumbers,
  whatsappEnabled,
  telegramToken,
  telegramAllowedUsers,
  permissionMode,
  defaultCwd: resolvePath(env("DEFAULT_CWD", "~/Projects")),
  // Parent directory for projects created by /new.
  workspacesRoot: resolvePath(env("WORKSPACES_ROOT", "~/Projects")),
  projectSearchRoots: env("PROJECT_SEARCH_ROOTS", "~/Desktop,~/Documents,~/Projects")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => resolvePath(p)),
  defaultEngine: engine,
  defaultModel: env("DEFAULT_MODEL") || null,
  dbPath: resolvePath(env("DB_PATH", "./data/bridge.sqlite3")),
  promptIdleMs: envNumber("PROMPT_IDLE_MS", 1400),
  progressCheckMs: envNumber("PROGRESS_CHECK_MS", 20_000),
  waitingTimeoutMinutes: envNumber("WAITING_TIMEOUT_MINUTES", 30),
  maxTaskHours: envNumber("MAX_TASK_HOURS", 12),
  maxActiveSessions: envNumber("MAX_ACTIVE_SESSIONS", 8),
  maxMessagesPerMinute: envNumber("MAX_MESSAGES_PER_MINUTE", 60),
  reapIdleHours: envNumber("REAP_IDLE_HOURS", 48),
  logLevel: env("LOG_LEVEL", "info") as LogLevel,
  whatsappAccessToken,
  whatsappPhoneNumberId,
  whatsappVerifyToken,
  whatsappAppSecret: whatsappAppSecret || null,
  webhookHost: env("WEBHOOK_HOST", "127.0.0.1"),
  webhookPort: envNumber("WEBHOOK_PORT", 3000),
  graphApiVersion: env("GRAPH_API_VERSION"),
  webhookMaxAgeMs: envNumber("WEBHOOK_MAX_AGE_MINUTES", 10) * 60_000,
};

export function isAllowedNumber(from: string): boolean {
  return /^\d{7,15}$/.test(from) && config.allowedNumbers.has(from);
}

export function validateConfig(): void {
  if (!config.whatsappEnabled && !config.telegramToken) {
    throw new Error("Configure WhatsApp or Telegram before starting the bridge");
  }
  if (config.whatsappEnabled) {
    if (
      !config.whatsappAccessToken ||
      !config.whatsappPhoneNumberId ||
      !config.whatsappVerifyToken ||
      !config.whatsappAppSecret
    ) {
      throw new Error(
        "WhatsApp requires WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN, and WHATSAPP_APP_SECRET",
      );
    }
    if (config.allowedNumbers.size === 0) throw new Error("WhatsApp requires ALLOWED_NUMBERS");
    for (const number of allowedNumbersRaw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)) {
      if (!/^[+\d\s().-]+$/.test(number) || !/^\d{7,15}$/.test(normalizeNumber(number))) {
        throw new Error("ALLOWED_NUMBERS must contain valid international phone numbers");
      }
    }
    if (!/^v\d+\.\d+$/.test(config.graphApiVersion))
      throw new Error("WhatsApp requires GRAPH_API_VERSION in the form vN.N");
  }
  if (config.telegramToken) {
    if (config.telegramAllowedUsers.size === 0) throw new Error("Telegram requires TELEGRAM_ALLOWED_USER_IDS");
    for (const id of config.telegramAllowedUsers) {
      if (!/^\d+$/.test(id)) throw new Error(`Invalid Telegram user ID: ${id}`);
    }
  }
  if (!Number.isInteger(config.maxActiveSessions) || config.maxActiveSessions < 1) {
    throw new Error("MAX_ACTIVE_SESSIONS must be a positive integer");
  }
  if (!Number.isInteger(config.maxMessagesPerMinute) || config.maxMessagesPerMinute < 1) {
    throw new Error("MAX_MESSAGES_PER_MINUTE must be a positive integer");
  }
  if (!Number.isInteger(config.webhookPort) || config.webhookPort < 1 || config.webhookPort > 65535) {
    if (config.whatsappEnabled) throw new Error("WEBHOOK_PORT must be between 1 and 65535");
  }
  if (
    [config.promptIdleMs, config.progressCheckMs].some(
      (value) => !Number.isInteger(value) || value < 100 || value > 2_147_483_647,
    )
  ) {
    throw new Error("PROMPT_IDLE_MS and PROGRESS_CHECK_MS must be integers between 100 and 2147483647");
  }
  if (config.webhookMaxAgeMs <= 0) throw new Error("WEBHOOK_MAX_AGE_MINUTES must be positive");
  if (!Number.isFinite(config.waitingTimeoutMinutes) || config.waitingTimeoutMinutes < 0) {
    throw new Error("WAITING_TIMEOUT_MINUTES must be zero or positive");
  }
  if (config.maxTaskHours < 0) throw new Error("MAX_TASK_HOURS must be zero or positive");
  if (!Number.isFinite(config.reapIdleHours) || config.reapIdleHours < 0) {
    throw new Error("REAP_IDLE_HOURS must be zero or positive");
  }
  if (!["fatal", "error", "warn", "info", "debug", "trace"].includes(config.logLevel)) {
    throw new Error("LOG_LEVEL must be fatal, error, warn, info, debug, or trace");
  }
}
