import type Database from "better-sqlite3";

export class BridgeState {
  constructor(private readonly db: Database.Database) {}

  getNumber(key: string): number {
    const row = this.db.prepare("SELECT value FROM bridge_state WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    const value = Number(row?.value ?? 0);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  setNumber(key: string, value: number): void {
    this.db
      .prepare(
        "INSERT INTO bridge_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, String(value));
  }

  claimEvent(id: string, ttlMs = 24 * 60 * 60 * 1000): boolean {
    const now = Date.now();
    return this.db.transaction(() => {
      this.db.prepare("DELETE FROM seen_events WHERE receivedAt < ?").run(now - ttlMs);
      const result = this.db.prepare("INSERT OR IGNORE INTO seen_events (id, receivedAt) VALUES (?, ?)").run(id, now);
      return result.changes === 1;
    })();
  }
}
