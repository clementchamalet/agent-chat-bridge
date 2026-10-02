import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { config, validateConfig } from "./config.js";
import { ENGINES } from "./pty/engines.js";

let failed = false;
const report = (ok: boolean, label: string, detail = ""): void => {
  console.log(`${ok ? "OK" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
};

try {
  validateConfig();
  report(true, "Configuration");
} catch (err) {
  report(false, "Configuration", err instanceof Error ? err.message : String(err));
}

for (const [bin, args] of [
  ["tmux", ["-V"]],
  [ENGINES[config.defaultEngine].bin, ["--version"]],
] as const) {
  const result = spawnSync(bin, args, { timeout: 5000, stdio: "ignore" });
  report(!result.error && result.status === 0, `${bin} executable`);
}

try {
  fs.mkdirSync(config.defaultCwd, { recursive: true });
  fs.accessSync(config.defaultCwd, fs.constants.W_OK);
  report(true, "Default working directory", config.defaultCwd);
} catch (err) {
  report(false, "Default working directory", err instanceof Error ? err.message : String(err));
}

try {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  fs.accessSync(path.dirname(config.dbPath), fs.constants.W_OK);
  report(true, "Database directory", path.dirname(config.dbPath));
} catch (err) {
  report(false, "Database directory", err instanceof Error ? err.message : String(err));
}

report(!config.whatsappEnabled || (config.webhookPort >= 1 && config.webhookPort <= 65535), "WhatsApp webhook port");
console.log(
  `Channels: ${[config.whatsappEnabled && "WhatsApp", config.telegramToken && "Telegram"].filter(Boolean).join(", ") || "none"}`,
);
console.log(`Agent permissions: ${config.permissionMode}`);
process.exitCode = failed ? 1 : 0;
