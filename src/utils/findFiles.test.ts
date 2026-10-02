import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findFiles } from "./findFiles.js";

describe("findFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "find-files-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("matches by case-insensitive substring against the relative path", async () => {
    fs.writeFileSync(path.join(dir, "Report.md"), "x");
    fs.writeFileSync(path.join(dir, "notes.txt"), "x");

    expect(await findFiles(dir, "report")).toEqual([path.join(dir, "Report.md")]);
  });

  it("returns everything, most-recent first, for an empty query", async () => {
    fs.writeFileSync(path.join(dir, "old.txt"), "x");
    await new Promise((r) => setTimeout(r, 5));
    fs.writeFileSync(path.join(dir, "new.txt"), "x");

    expect(await findFiles(dir, "")).toEqual([path.join(dir, "new.txt"), path.join(dir, "old.txt")]);
  });

  it("ignores node_modules and similar dirs", async () => {
    fs.mkdirSync(path.join(dir, "node_modules"));
    fs.writeFileSync(path.join(dir, "node_modules", "report.md"), "x");

    expect(await findFiles(dir, "report")).toEqual([]);
  });

  it("returns nothing for a query that matches no file", async () => {
    fs.writeFileSync(path.join(dir, "notes.txt"), "x");
    expect(await findFiles(dir, "does-not-exist")).toEqual([]);
  });

  it("caps results to the given limit", async () => {
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), "x");
    expect(await findFiles(dir, "", 3)).toHaveLength(3);
  });
});
