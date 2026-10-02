import { describe, expect, it } from "vitest";
import { formatProjectLabel } from "./paths.js";

describe("formatProjectLabel", () => {
  it("returns the plain basename for a normal project directory", () => {
    expect(formatProjectLabel("/Users/example/Desktop/blog")).toBe("blog");
  });

  it("returns 'project / worktree' for a .claude/worktrees checkout instead of the opaque slug alone", () => {
    expect(formatProjectLabel("/Users/example/Projects/sample-app/.claude/worktrees/feature-worktree")).toBe(
      "sample-app / feature-worktree",
    );
  });

  it("falls back to the basename when there's no project segment before .claude", () => {
    expect(formatProjectLabel("/.claude/worktrees/some-slug")).toBe("some-slug");
  });
});
