import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ClaudeTurn,
  TranscriptTail,
  claudeProjectDirName,
  findClaudeTranscript,
  formatAsk,
  isAssistantActivity,
  isUserPrompt,
  latestTurnStartOffset,
  prettyModelName,
  readClaudeRegistryForPid,
  type TranscriptRecord,
} from "./claudeObserver.js";

const prompt = (text: string, extra: Record<string, unknown> = {}): TranscriptRecord => ({
  type: "user",
  uuid: `u-${text.length}`,
  message: { role: "user", content: text },
  ...extra,
});
const assistantText = (uuid: string, text: string, stop = "end_turn"): TranscriptRecord => ({
  type: "assistant",
  uuid,
  message: { role: "assistant", stop_reason: stop, content: [{ type: "text", text }] },
});
const toolUse = (uuid: string, name: string, input: unknown = {}, id = `toolu_${uuid}`): TranscriptRecord => ({
  type: "assistant",
  uuid,
  message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] },
});
const toolResult = (toolUseId: string): TranscriptRecord => ({
  type: "user",
  uuid: `r-${toolUseId}`,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }] },
});

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-observer-test-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("TranscriptTail", () => {
  it("returns only complete lines, and each record exactly once", () => {
    const file = path.join(dir, "t.jsonl");
    fs.writeFileSync(file, `${JSON.stringify(prompt("a"))}\n${JSON.stringify(prompt("bb"))}\n{"type":"us`);
    const tail = new TranscriptTail(file);

    expect(tail.readNew().map((r) => (r.message as { content: string }).content)).toEqual(["a", "bb"]);
    expect(tail.readNew()).toEqual([]);

    fs.appendFileSync(file, `er","message":{"content":"ccc"}}\n`);
    expect(tail.readNew().map((r) => (r.message as { content: string }).content)).toEqual(["ccc"]);
  });

  it("never mangles a multi-byte character split across two reads", () => {
    const file = path.join(dir, "t.jsonl");
    const line = Buffer.from(`${JSON.stringify(assistantText("x", "Unicode 🙂 reply"))}\n`, "utf8");
    const cut = line.indexOf(Buffer.from("🙂", "utf8")) + 1;
    fs.writeFileSync(file, line.subarray(0, cut));
    const tail = new TranscriptTail(file);
    expect(tail.readNew()).toEqual([]);

    fs.appendFileSync(file, line.subarray(cut));
    const [record] = tail.readNew();
    expect((record!.message as { content: { text: string }[] }).content[0]!.text).toBe("Unicode 🙂 reply");
  });

  it("starts from the given offset, skipping history", () => {
    const file = path.join(dir, "t.jsonl");
    fs.writeFileSync(file, `${JSON.stringify(prompt("old"))}\n`);
    const tail = new TranscriptTail(file, fs.statSync(file).size);
    fs.appendFileSync(file, `${JSON.stringify(prompt("new"))}\n`);
    expect(tail.readNew().map((r) => (r.message as { content: string }).content)).toEqual(["new"]);
  });
});

describe("isUserPrompt / isAssistantActivity", () => {
  it("counts a typed prompt, but not tool results, meta injections, interruptions, sidechains or local-command output", () => {
    expect(isUserPrompt(prompt("write a report"))).toBe(true);
    expect(isUserPrompt(toolResult("toolu_1"))).toBe(false);
    expect(isUserPrompt(prompt("<system-reminder>…", { isMeta: true }))).toBe(false);
    expect(isUserPrompt(prompt("x", { isSidechain: true }))).toBe(false);
    expect(
      isUserPrompt({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }),
    ).toBe(false);
    expect(isUserPrompt(prompt("<local-command-stdout>Compacted</local-command-stdout>"))).toBe(false);
  });

  it("recognizes Claude acting on its own (text or tool call), not a thinking-only record", () => {
    expect(isAssistantActivity(assistantText("a", "long task complete"))).toBe(true);
    expect(isAssistantActivity(toolUse("b", "Bash"))).toBe(true);
    expect(
      isAssistantActivity({ type: "assistant", message: { content: [{ type: "thinking", thinking: "…" }] } }),
    ).toBe(false);
    expect(isAssistantActivity({ ...assistantText("c", "sub-agent"), isSidechain: true })).toBe(false);
  });
});

describe("ClaudeTurn", () => {
  it("reports each text block once: narration mid-turn, the rest (the final answer) at the end — never duplicated", () => {
    const turn = new ClaudeTurn();
    turn.ingest(prompt("refactor"));
    turn.ingest(assistantText("1", "I am inspecting the code.", "tool_use"));
    turn.ingest(toolUse("2", "Read"));
    turn.ingest(toolResult("toolu_2"));
    turn.ingest(assistantText("3", "The task is complete."));

    expect(turn.takeNarration()).toEqual(["I am inspecting the code."]);
    expect(turn.takeNarration()).toEqual([]);
    expect(turn.takeToolDelta()).toBe(1);
    expect(turn.takeUnsent()).toEqual(["The task is complete."]);
    expect(turn.takeUnsent()).toEqual([]);
    expect(turn.takeToolDelta()).toBe(0);
  });

  it("tracks a pending AskUserQuestion until its tool_result arrives, without counting it as a tool call", () => {
    const turn = new ClaudeTurn();
    turn.ingest(prompt("ask me"));
    turn.ingest(
      toolUse("q", "AskUserQuestion", {
        questions: [
          {
            question: "Which language?",
            header: "Language",
            options: [{ label: "Python" }, { label: "Rust", description: "Fast" }],
          },
        ],
      }),
    );
    expect(turn.pendingAsk?.questions[0]?.options.map((o) => o.label)).toEqual(["Python", "Rust"]);
    expect(turn.toolCount).toBe(0);

    turn.ingest(toolResult("toolu_q"));
    expect(turn.pendingAsk).toBeNull();
  });

  it("flags an interrupted turn and keeps the partial text", () => {
    const turn = new ClaudeTurn();
    turn.ingest(prompt("count to 200"));
    turn.ingest({ type: "assistant", uuid: "p", message: { content: [{ type: "text", text: "1. One\n2. Two" }] } });
    turn.ingest({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } });
    expect(turn.interrupted).toBe(true);
    expect(turn.takeUnsent()).toEqual(["1. One\n2. Two"]);
  });

  it("keeps a local slash command's own output (e.g. /compact) as the reply", () => {
    const turn = new ClaudeTurn();
    turn.ingest(prompt("<command-name>/compact</command-name>"));
    turn.ingest(prompt("<local-command-stdout>Compacted </local-command-stdout>"));
    expect(turn.localOutput).toEqual(["Compacted"]);
    expect(turn.sawAssistant).toBe(false);
  });

  it("ignores sidechain (sub-agent) records", () => {
    const turn = new ClaudeTurn();
    turn.ingest({ ...assistantText("s", "sub-agent chatter"), isSidechain: true });
    expect(turn.takeUnsent()).toEqual([]);
  });
});

describe("latestTurnStartOffset", () => {
  it("points at the last real prompt, skipping tool results and meta lines after it", () => {
    const file = path.join(dir, "t.jsonl");
    const lines = [
      prompt("first"),
      assistantText("a", "reply 1"),
      prompt("second"),
      toolUse("b", "Bash"),
      toolResult("toolu_b"),
      prompt("<system-reminder>", { isMeta: true }),
      assistantText("c", "reply 2"),
    ].map((r) => `${JSON.stringify(r)}\n`);
    fs.writeFileSync(file, lines.join(""));

    const offset = latestTurnStartOffset(file);
    expect(offset).toBe(Buffer.byteLength(lines[0]! + lines[1]!));
    const tail = new TranscriptTail(file, offset);
    expect((tail.readNew()[0]!.message as { content: string }).content).toBe("second");
  });
});

describe("locating Claude Code's files", () => {
  it("finds a transcript under the cwd's project-dir slug, or by scanning every project dir", () => {
    const cwd = "/Users/example/Projects/app/.claude/worktrees/x";
    expect(claudeProjectDirName(cwd)).toBe("-Users-example-Projects-app--claude-worktrees-x");

    fs.mkdirSync(path.join(dir, claudeProjectDirName(cwd)));
    fs.writeFileSync(path.join(dir, claudeProjectDirName(cwd), "abc.jsonl"), "");
    expect(findClaudeTranscript("abc", cwd, dir)).toBe(path.join(dir, claudeProjectDirName(cwd), "abc.jsonl"));

    fs.mkdirSync(path.join(dir, "-elsewhere"));
    fs.writeFileSync(path.join(dir, "-elsewhere", "def.jsonl"), "");
    expect(findClaudeTranscript("def", cwd, dir)).toBe(path.join(dir, "-elsewhere", "def.jsonl"));
    expect(findClaudeTranscript("nope", cwd, dir)).toBeNull();
  });

  it("reads a process's registry status, and treats an unknown status as absent", () => {
    fs.writeFileSync(path.join(dir, "4242.json"), JSON.stringify({ pid: 4242, sessionId: "s-1", status: "waiting" }));
    fs.writeFileSync(path.join(dir, "4343.json"), JSON.stringify({ pid: 4343, sessionId: "s-2" }));
    expect(readClaudeRegistryForPid(4242, dir)).toEqual({ status: "waiting", sessionId: "s-1" });
    expect(readClaudeRegistryForPid(4343, dir)).toEqual({ status: null, sessionId: "s-2" });
    expect(readClaudeRegistryForPid(9999, dir)).toBeNull();
  });
});

describe("prettyModelName", () => {
  it("renders an API model id the way Claude Code's banner does", () => {
    expect(prettyModelName("claude-sonnet-5")).toBe("Sonnet 5");
    expect(prettyModelName("claude-opus-5")).toBe("Opus 5");
    expect(prettyModelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(prettyModelName("<synthetic>")).toBeNull();
  });

  it("is captured from the turn's assistant messages, ignoring CLI-generated notices", () => {
    const turn = new ClaudeTurn();
    turn.ingest({ type: "assistant", message: { model: "claude-sonnet-5", content: [{ type: "text", text: "a" }] } });
    turn.ingest({ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "limit" }] } });
    expect(turn.model).toBe("claude-sonnet-5");
  });
});

describe("formatAsk", () => {
  it("numbers options exactly like Claude Code's own menu, one question at a time", () => {
    const ask = {
      toolUseId: "t",
      questions: [
        {
          question: "Which language?",
          header: "Language",
          options: [{ label: "Python", description: "Simple" }, { label: "Rust" }],
        },
        { question: "Which season?", options: [{ label: "Summer" }, { label: "Winter" }] },
      ],
    };
    const first = formatAsk(ask, 0);
    expect(first).toContain("**Question 1/2**");
    expect(first).toContain("1. Python — *Simple*");
    expect(first).toContain("2. Rust");
    expect(first).not.toContain("Which season");
    expect(formatAsk(ask, 1)).toContain("1. Summer");
  });
});
