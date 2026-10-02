import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDocument } from "./document.js";

describe("readDocument", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-document-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("reads a regular file and enforces the byte limit", () => {
    const file = path.join(dir, "report.txt");
    fs.writeFileSync(file, "report");
    expect(readDocument(file, 6).toString()).toBe("report");
    expect(() => readDocument(file, 5)).toThrow("size limit");
    expect(() => readDocument(dir, 100)).toThrow("regular file");
  });

  it("blocks a picker entry replaced by a symbolic link", () => {
    const secret = path.join(dir, ".env");
    const file = path.join(dir, "report.txt");
    fs.writeFileSync(secret, "secret");
    fs.symlinkSync(secret, file);
    expect(() => readDocument(file, 100)).toThrow("sensitive file or symbolic link");
  });

  it("blocks private files reached through a parent-directory link", () => {
    const privateDir = path.join(dir, ".aws");
    fs.mkdirSync(privateDir);
    fs.writeFileSync(path.join(privateDir, "config"), "secret");
    fs.symlinkSync(privateDir, path.join(dir, "public"));
    expect(() => readDocument(path.join(dir, "public", "config"), 100)).toThrow("sensitive");
  });
});
