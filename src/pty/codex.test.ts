import { describe, expect, it } from "vitest";
import { extractModelNameCodex, extractReply } from "./frameSummary.js";
import { classifyFrame, isReadyForInput, parseMenu } from "./promptDetector.js";
import { formatAgentContent } from "../channel/outbound.js";

describe("Codex terminal support", () => {
  it("removes wrapped input and terminal metadata from the reply", () => {
    const frame = `› Build a small application with a long description that wraps
  onto another line in the terminal.

• Created index.html.
  The application supports adding and removing tasks.

› Ask Codex to do anything
  gpt-example high · ~/project · ← for agents`;
    const reply = extractReply(frame, null, null, "codex");
    expect(reply.body).toBe("Created index.html.\n  The application supports adding and removing tasks.");
  });

  it("does not report wrapped input as a reply before output arrives", () => {
    expect(extractReply("› Build a small application\n  with additional features.", null, null, "codex").body).toBe("");
  });

  it("turns a wrapped API error into a readable message", () => {
    const frame = `› Build a small application with a long description that wraps
  onto another line in the terminal.

■ {"type":"error","status":400,"error":{"message":"The selected model is not
supported for this account."}}

› Ask Codex to do anything
  gpt-example high · ~/project · ← for agents`;
    expect(extractReply(frame, null, null, "codex").body).toBe(
      "❌ The selected model is not supported for this account.",
    );
  });

  it("handles a truncated API error without forwarding broken JSON", () => {
    const frame = '› Build an application\n\n■ {"type":"error","error":';
    expect(extractReply(frame, null, null, "codex").body).toBe(
      "❌ Codex could not complete the request. Use /screen for details.",
    );
  });

  it("reads the active model from the latest footer or boot banner", () => {
    expect(extractModelNameCodex("│ model: gpt-old /model to change │")).toBe("gpt-old");
    expect(
      extractModelNameCodex("│ model: gpt-old /model to change │\n  gpt-new high · ~/project · ← for agents"),
    ).toBe("gpt-new");
    expect(extractModelNameCodex("No model is shown.")).toBeNull();
  });

  it("removes completion metadata when the footer shows a conversation title", () => {
    const frame = `› Reply exactly OK

• OK

  Worked for 2s • 12:12

› Ask Codex to do anything
  GPT-Example high · ~/project · Greeting · 1 warning · f2 to view`;
    expect(extractModelNameCodex(frame)).toBe("GPT-Example");
    expect(extractReply(frame, "GPT-Example", null, "codex")).toEqual({ meta: "", body: "OK" });
  });

  it("recognizes an approval menu and keeps the selected option in the question", () => {
    const frame =
      "Would you like to run this command?\n\n› 1. Yes, proceed\n  2. No, cancel\n\n› Ask Codex to do anything";
    expect(classifyFrame(frame, "codex")).toBe("question");
    expect(isReadyForInput(frame, "codex")).toBe(false);
    expect(parseMenu(frame)).toEqual({ cursorIndex: 0, count: 2 });
    expect(extractReply(frame, null, null, "codex").body).toContain("1. Yes, proceed");
  });
  it("recognizes an idle Codex prompt and isolates the latest reply", () => {
    const boot = `╭──────────────────────────────────╮
│ >_ OpenAI Codex (v0.158.0)       │
│ model: GPT-6-Luna /model to change │
╰──────────────────────────────────╯
  › Ask Codex to do anything
  GPT-6-Luna high · ~/project · ← for agents`;
    expect(classifyFrame(boot, "codex")).toBe("complete");
    expect(isReadyForInput(boot, "codex")).toBe(true);

    const settled = `${boot}\n  › Summarize this file\n  • The file defines a bridge.\n  › Ask Codex to do anything`;
    expect(extractReply(settled, null, null, "codex").body).toBe("The file defines a bridge.");
  });

  it("sanitizes raw tool blocks when a transcript is unavailable", () => {
    const frame = `› Build a task list

• I will build the application.

• Ran pwd; rg --files
  └ /project

• Explored
  └ List ls -la

• Ran a wrapped command
  │ with additional arguments
  └ (no output)

• The application is ready.
  - Add tasks
  - Complete tasks

› Ask Codex to do anything`;
    expect(formatAgentContent(extractReply(frame, null, null, "codex").body)).toBe(
      "> (3 commands run)\n\nI will build the application.\n\nThe application is ready.\n  - Add tasks\n  - Complete tasks",
    );
  });
});
