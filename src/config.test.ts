import { afterEach, describe, expect, it, vi } from "vitest";
import { config, isAllowedNumber, validateConfig } from "./config.js";

const original = { ...config };
afterEach(() => {
  Object.assign(config, original);
  vi.unstubAllEnvs();
});

function validTelegram(): void {
  Object.assign(config, { whatsappEnabled: false, telegramToken: "test", telegramAllowedUsers: new Set(["123"]) });
}

describe("configuration", () => {
  it.each([NaN, 99, 100.5, 2_147_483_648])("rejects an unsafe observation interval %s", (value) => {
    validTelegram();
    config.promptIdleMs = value;
    expect(validateConfig).toThrow("PROMPT_IDLE_MS");
  });

  it("requires a channel and a user allowlist", () => {
    Object.assign(config, { whatsappEnabled: false, telegramToken: "" });
    expect(validateConfig).toThrow("Configure WhatsApp or Telegram");
    validTelegram();
    config.telegramAllowedUsers = new Set();
    expect(validateConfig).toThrow("TELEGRAM_ALLOWED_USER_IDS");
  });

  it("rejects sender strings containing an allowed number and path syntax", () => {
    config.allowedNumbers = new Set(["15550009999"]);
    expect(isAllowedNumber("15550009999")).toBe(true);
    expect(isAllowedNumber("../15550009999")).toBe(false);
    expect(isAllowedNumber("abc15550009999")).toBe(false);
  });
});
