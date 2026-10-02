import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "./database.js";
import { BridgeState } from "./state.js";

describe("BridgeState", () => {
  it("persists delivery claims and the Telegram offset across reopen", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-state-test-"));
    const dbPath = path.join(dir, "bridge.sqlite3");
    try {
      const first = openDatabase(dbPath);
      const state = new BridgeState(first);
      expect(state.claimEvent("wa:message-1")).toBe(true);
      expect(state.claimEvent("wa:message-1")).toBe(false);
      state.setNumber("telegram_offset", 42);
      first.close();

      const reopened = openDatabase(dbPath);
      const restored = new BridgeState(reopened);
      expect(restored.claimEvent("wa:message-1")).toBe(false);
      expect(restored.getNumber("telegram_offset")).toBe(42);
      reopened.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
