import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexObserver, CodexTurn } from "./codexObserver.js";

const start = (id: string) => ({ type: "event_msg", payload: { type: "task_started", turn_id: id } });
const finish = { type: "event_msg", payload: { type: "task_complete" } };
const message = (id: string, text: string, phase = "commentary") => ({
  type: "response_item",
  payload: { type: "message", id, role: "assistant", phase, content: [{ type: "output_text", text }] },
});
const tool = (id: string) => ({
  type: "response_item",
  payload: { type: "custom_tool_call", call_id: id, name: "exec_command", input: "raw command" },
});

describe("CodexTurn", () => {
  it("emits only new narration and aggregates tool activity without its details", () => {
    const turn = new CodexTurn();
    turn.ingest(start("first"));
    turn.ingest(message("intro", "I will create the application."));
    turn.ingest(tool("one"));
    expect(turn.takeProgress()).toEqual({ text: "I will create the application.", toolCount: 1 });
    turn.ingest(tool("two"));
    turn.ingest({
      type: "response_item",
      payload: { type: "custom_tool_call_output", call_id: "two", output: "raw output" },
    });
    expect(turn.takeProgress()).toBeNull();
    turn.ingest(message("next", "The application is ready for verification."));
    expect(turn.takeProgress()).toEqual({ text: "The application is ready for verification.", toolCount: 1 });
    turn.ingest(message("final", "Created index.html.\n\n- Add tasks\n- Complete tasks", "final_answer"));
    expect(turn.takeProgress()).toBeNull();
    turn.ingest(finish);
    expect(turn.takeFinal()).toEqual({ text: "Created index.html.\n\n- Add tasks\n- Complete tasks", toolCount: 0 });
    expect(turn.takeFinal()).toBeNull();
  });

  it("preserves all narration when progress is disabled and ignores duplicate item records", () => {
    const turn = new CodexTurn();
    turn.ingest(start("first"));
    const intro = message("intro", "I will check the file.");
    turn.ingest(intro);
    turn.ingest(intro);
    turn.ingest(tool("one"));
    turn.ingest(tool("one"));
    turn.ingest({ type: "response_item", payload: { type: "reasoning", summary: [{ text: "private reasoning" }] } });
    turn.ingest(message("final", "Checked.", "final_answer"));
    turn.ingest(finish);
    expect(turn.takeFinal()).toEqual({ text: "I will check the file.\n\nChecked.", toolCount: 1 });
  });

  it("resets the latest turn and safely skips malformed records", () => {
    const turn = new CodexTurn();
    turn.ingest(start("old"));
    turn.ingest(message("old", "Old reply.", "final_answer"));
    turn.ingest(finish);
    turn.ingest(start("new"));
    turn.ingest({ type: "response_item", payload: null });
    turn.ingest({ type: "response_item", payload: ["invalid"] });
    turn.ingest(message("new", "New reply.", "final_answer"));
    turn.ingest(finish);
    expect(turn.takeFinal()).toEqual({ text: "New reply.", toolCount: 0 });
  });

  it("does not invent a successful reply for a turn without assistant text", () => {
    const turn = new CodexTurn();
    turn.ingest(start("empty"));
    turn.ingest(finish);
    expect(turn.takeFinal()).toEqual({ text: "", toolCount: 0 });
  });
});

describe("CodexObserver", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-observer-test-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("binds the submitted prompt to its transcript and waits for complete JSON lines", () => {
    const file = path.join(root, "rollout-current.jsonl");
    const records = [
      { type: "session_meta", payload: { id: "current", cwd: "/project" } },
      start("first"),
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Build a page" }] },
      },
      message("intro", "I will build the page."),
      tool("one"),
    ];
    fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    const observer = new CodexObserver("/project", null, 0, root);
    observer.submitted("Build a page");
    observer.read();
    expect(observer.turn.takeProgress()).toEqual({ text: "I will build the page.", toolCount: 1 });
    const final = JSON.stringify(message("final", "Created the page.", "final_answer"));
    fs.appendFileSync(file, final.slice(0, 25));
    observer.read();
    expect(observer.turn.takeFinal()).toBeNull();
    fs.appendFileSync(file, final.slice(25) + "\n" + JSON.stringify(finish) + "\n");
    observer.read();
    expect(observer.turn.takeFinal()).toEqual({ text: "Created the page.", toolCount: 0 });
  });

  it("does not select another prompt in the same directory", () => {
    fs.writeFileSync(
      path.join(root, "rollout-other.jsonl"),
      [
        { type: "session_meta", payload: { id: "other", cwd: "/project" } },
        start("other"),
        { type: "response_item", payload: { role: "user", content: [{ text: "Other task" }] } },
        message("other", "Other reply.", "final_answer"),
        finish,
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );
    const observer = new CodexObserver("/project", null, 0, root);
    observer.submitted("Build a page");
    observer.read();
    expect(observer.turn.started).toBe(false);
    expect(observer.turn.takeFinal()).toBeNull();
  });

  it("reconstructs only the latest turn of a resumed conversation", () => {
    const file = path.join(root, "rollout-current.jsonl");
    fs.writeFileSync(
      file,
      [
        { type: "session_meta", payload: { id: "current", cwd: "/project" } },
        start("old"),
        message("old", "Old reply.", "final_answer"),
        finish,
        start("new"),
        tool("new"),
        message("new", "New reply.", "final_answer"),
        finish,
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );
    const observer = new CodexObserver("/project", "current", 0, root);
    observer.read();
    expect(observer.turn.takeFinal()).toEqual({ text: "New reply.", toolCount: 1 });
    observer.submitted("Another task");
    observer.read();
    expect(observer.turn.takeFinal()).toBeNull();
  });
});
