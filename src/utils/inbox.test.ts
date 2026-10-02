import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareInboxDirectory, pruneExpiredImages } from "./inbox.js";

describe("image inbox", () => {
  let dir: string;
  let root: string;
  let now: number;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-inbox-test-"));
    root = path.join(dir, "inbox");
    now = Date.now();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function expiredFile(parent: string): string {
    const file = path.join(parent, "expired.jpg");
    fs.writeFileSync(file, "image");
    fs.utimesSync(file, new Date(now), new Date(now - 2 * 86_400_000));
    return file;
  }

  it("removes expired images while preserving recent files and directories", () => {
    const user = prepareInboxDirectory("tg:123", root);
    const expired = expiredFile(user);
    const recent = path.join(user, "recent.jpg");
    fs.writeFileSync(recent, "image");
    fs.mkdirSync(path.join(user, "nested"));
    expect(pruneExpiredImages(root, now)).toBe(1);
    expect(fs.existsSync(expired)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(path.join(user, "nested"))).toBe(true);
  });

  it("does not follow linked inboxes, user directories, or files", () => {
    const external = path.join(dir, "external");
    fs.mkdirSync(external);
    const outsideFile = expiredFile(external);
    fs.symlinkSync(external, root);
    expect(pruneExpiredImages(root, now)).toBe(0);
    expect(() => prepareInboxDirectory("tg:123", root)).toThrow("symbolic links");
    fs.unlinkSync(root);
    const user = prepareInboxDirectory("tg:123", root);
    fs.symlinkSync(external, path.join(root, "linked-user"));
    fs.symlinkSync(outsideFile, path.join(user, "linked.jpg"));
    expect(pruneExpiredImages(root, now)).toBe(0);
    expect(fs.readFileSync(outsideFile, "utf8")).toBe("image");
    expect(() => prepareInboxDirectory("linked-user", root)).toThrow("symbolic links");
  });

  it.each(["", ".", "..", "../external", "nested/user", "nested\\user"])("rejects unsafe recipient paths (%s)", (jid) =>
    expect(() => prepareInboxDirectory(jid, root)).toThrow("Invalid inbox recipient"),
  );

  it("creates private directories and handles a missing inbox", () => {
    expect(pruneExpiredImages(root, now)).toBe(0);
    const user = prepareInboxDirectory("15550100123", root);
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(fs.statSync(user).mode & 0o777).toBe(0o700);
  });
});
