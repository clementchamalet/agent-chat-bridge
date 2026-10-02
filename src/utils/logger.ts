export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export interface Logger {
  level: LogLevel;
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  fatal(...args: unknown[]): void;
  child(bindings: Record<string, unknown>): Logger;
}

const SECRET_KEYS = ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN", "TELEGRAM_BOT_TOKEN"];

function render(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function redact(value: string): string {
  let text = value;
  for (const key of SECRET_KEYS) {
    const secret = process.env[key]?.trim();
    if (secret) text = text.replaceAll(secret, "[REDACTED]");
  }
  return text;
}

function createLogger(level: LogLevel, component: string, bindings: Record<string, unknown>): Logger {
  const write = (lvl: LogLevel, args: unknown[]) => {
    if (LEVEL_WEIGHT[lvl] < LEVEL_WEIGHT[level]) return;
    const stream = lvl === "error" || lvl === "fatal" ? console.error : console.log;
    const fields = Object.fromEntries(Object.entries(bindings).map(([key, value]) => [key, redact(render(value))]));
    stream(
      JSON.stringify({
        ...fields,
        timestamp: new Date().toISOString(),
        level: lvl,
        component,
        message: redact(args.map(render).join(" ")),
      }),
    );
  };

  return {
    level,
    trace: (...args) => write("trace", args),
    debug: (...args) => write("debug", args),
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
    fatal: (...args) => write("fatal", args),
    child(extra: Record<string, unknown>) {
      return createLogger(level, component, { ...bindings, ...extra });
    },
  };
}

export function makeLogger(level: LogLevel = "info", prefix = "bridge"): Logger {
  return createLogger(level, prefix, {});
}
