import { describe, expect, it } from "vitest";
import { isSensitivePath } from "./sensitivePath.js";

describe("isSensitivePath", () => {
  it.each([
    ".env",
    "config/.env.local",
    "keys/private.pem",
    ".ssh/id_ed25519",
    ".aws/credentials",
    ".aws",
    ".gnupg/private-keys-v1.d/keyfile",
    ".git/config",
    "data/bridge.sqlite3",
    "data/bridge.sqlite3-wal",
    "data/bridge.db",
    "data/bridge.db-wal",
    "data/bridge.db-shm",
    "data/bridge.db-journal",
    "data/bridge.sqlite-journal",
    "data/bridge.sqlite3-journal",
  ])("blocks %s", (file) => expect(isSensitivePath(file)).toBe(true));

  it.each(["src/index.ts", ".github/workflows/ci.yml", "README.md", ".env.example", ".env.sample", ".env.template"])(
    "allows %s",
    (file) => expect(isSensitivePath(file)).toBe(false),
  );
});
