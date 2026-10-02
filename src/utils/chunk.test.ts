import { describe, expect, it } from "vitest";
import { chunkMessage, codeFence } from "./chunk.js";

describe("chunkMessage", () => {
  it("returns the original text untouched when under the limit", () => {
    expect(chunkMessage("hello world")).toEqual(["hello world"]);
  });

  it("splits long text into multiple chunks, each within the limit", () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const chunks = chunkMessage(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(200);
    }
    expect(chunks.join("\n")).toContain("line 0");
    expect(chunks.join("\n")).toContain("line 499");
  });

  it("re-opens and closes a code fence split across chunks", () => {
    const body = Array.from({ length: 100 }, (_, i) => `console.log(${i});`).join("\n");
    const text = `intro text\n\`\`\`js\n${body}\n\`\`\`\nfollowing text`;
    const chunks = chunkMessage(text, 150);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const fenceCount = (chunk.match(/```/g) ?? []).length;
      expect(fenceCount % 2).toBe(0);
    }
  });

  it("hard-splits a single line longer than the limit", () => {
    const longLine = "x".repeat(500);
    const chunks = chunkMessage(longLine, 100);
    expect(chunks.length).toBe(5);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
  });

  it("reserves room for closing fences and keeps long fenced lines balanced", () => {
    for (let limit = 16; limit <= 80; limit++) {
      const chunks = chunkMessage(`intro\n\`\`\`js\n${"x".repeat(400)}\n\`\`\`\nafter`, limit);
      expect(chunks.every((chunk) => chunk.length <= limit)).toBe(true);
      expect(chunks.every((chunk) => (chunk.match(/```/g) ?? []).length % 2 === 0)).toBe(true);
      expect(chunks.join("").match(/x/g)).toHaveLength(400);
    }
  });

  it("never splits an emoji's surrogate pair", () => {
    const text = "😀".repeat(50);
    const chunks = chunkMessage(text, 17);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
  });

  it.each([0, -1, NaN, Infinity, 3.5])("rejects invalid limits (%s)", (limit) => {
    expect(() => chunkMessage("text", limit)).toThrow(RangeError);
  });
});

describe("codeFence", () => {
  it("wraps text in a plain fence with no language tag", () => {
    expect(codeFence("diff --git a/notes.txt b/notes.txt")).toBe("```\ndiff --git a/notes.txt b/notes.txt\n```");
  });
});
