import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Exclude generated output and local worktree copies.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/worktrees/**"],
  },
});
