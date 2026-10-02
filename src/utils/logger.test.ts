import { afterEach, describe, expect, it, vi } from "vitest";
import { makeLogger } from "./logger.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("logger", () => {
  it("writes structured fields and redacts configured secrets", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "private-test-token");
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    makeLogger("info", "bridge").child({ mod: "telegram", session: "tg:123" }).info("token private-test-token");

    const record = JSON.parse(output.mock.calls[0]![0] as string);
    expect(record).toMatchObject({
      level: "info",
      component: "bridge",
      mod: "telegram",
      session: "tg:123",
      message: "token [REDACTED]",
    });
    expect(record.timestamp).toMatch(/^\d{4}-/);
  });

  it("does not write messages below the configured level", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    makeLogger("warn").info("hidden");
    expect(output).not.toHaveBeenCalled();
  });

  it.each(["  private-test-token  ", "abc"])("redacts normalized tokens regardless of length", (token) => {
    vi.stubEnv("WHATSAPP_VERIFY_TOKEN", token);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    makeLogger().info(`token ${token.trim()}`);
    expect(JSON.parse(output.mock.calls[0]![0] as string).message).toBe("token [REDACTED]");
  });
});
