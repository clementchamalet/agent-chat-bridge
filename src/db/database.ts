import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { config } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function openDatabase(dbPath = config.dbPath): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });

  const db = new Database(dbPath);
  try {
    if (dbPath !== ":memory:") fs.chmodSync(dbPath, 0o600);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    const migrations: (() => void)[] = [
      () => {
        const columns = new Set((db.pragma("table_info(sessions)") as { name: string }[]).map((c) => c.name));
        const additions = [
          ["tmuxSession", "TEXT NOT NULL DEFAULT ''"],
          ["verbose", "INTEGER NOT NULL DEFAULT 1"],
          ["resumeId", "TEXT"],
          ["title", "TEXT"],
          ["started", "INTEGER NOT NULL DEFAULT 0"],
          ["effort", "TEXT"],
          ["resolvedModel", "TEXT"],
        ] as const;
        for (const [name, definition] of additions) {
          if (!columns.has(name)) db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${definition}`);
        }
        if (columns.has("resumeNext")) db.exec("ALTER TABLE sessions DROP COLUMN resumeNext");
      },
      () =>
        db.exec(`
      CREATE TABLE IF NOT EXISTS bridge_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS seen_events (id TEXT PRIMARY KEY, receivedAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_seen_events_received ON seen_events(receivedAt);
    `),
      () => {
        const columns = new Set((db.pragma("table_info(sessions)") as { name: string }[]).map((c) => c.name));
        if (!columns.has("executionStartedAt")) db.exec("ALTER TABLE sessions ADD COLUMN executionStartedAt TEXT");
      },
    ];
    let version = db.pragma("user_version", { simple: true }) as number;
    if (version > migrations.length) throw new Error(`Database version ${version} is newer than this bridge supports`);
    const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
    db.exec(schema);
    for (const [index, migrate] of migrations.entries()) {
      if (version >= index + 1) continue;
      db.transaction(() => {
        migrate();
        version++;
        db.pragma(`user_version = ${version}`);
      })();
    }

    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}
