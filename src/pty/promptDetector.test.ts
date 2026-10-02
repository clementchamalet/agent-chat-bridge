import { describe, expect, it } from "vitest";
import { classifyFrame, parseMenu } from "./promptDetector.js";

describe("classifyFrame", () => {
  it("flags a yes/no confirmation as a question", () => {
    expect(classifyFrame("Overwrite existing file foo.ts? (y/n)")).toBe("question");
  });

  it("flags a numbered/menu selection as a question", () => {
    const frame = ["Which approach should I take?", "❯ 1. Rewrite the module", "  2. Patch the existing function"].join(
      "\n",
    );
    expect(classifyFrame(frame)).toBe("question");
  });

  it("doesn't let a strong-question phrase from an *earlier*, already-answered turn still on screen misclassify a later, genuinely finished turn", () => {
    const frame = [
      "⏺ The agent is ready.",
      "",
      "  What would you like to work on today?",
      "",
      "❯ which model are you using?",
      "",
      "⏺ The selected model is Haiku 4.5.",
      "",
      "  What should we work on next?",
      "",
      "❯",
    ].join("\n");

    expect(classifyFrame(frame)).toBe("complete");
  });

  it("still flags a strong-question phrase in the *current* turn, not just an old one", () => {
    const frame = [
      "⏺ Understood.",
      "",
      "❯ delete the example file",
      "",
      "⏺ Overwrite existing file foo.ts? (y/n)",
    ].join("\n");
    expect(classifyFrame(frame)).toBe("question");
  });

  it("treats the very first boot frame as complete, not a question, even with the effort footer and a suggestion box both present", () => {
    const frame = [
      " ▐▛███▛█   Claude Code v2.1.252",
      "▝▜██████▀  Sonnet 5 · Claude Pro",
      "  ▝▝ ▝▝    ~/Desktop",
      "",
      "                                                     ● high · /effort",
      "────────",
      '❯ Try "edit <filepath> to..."',
      "────────",
    ].join("\n");
    expect(classifyFrame(frame)).toBe("complete");
  });

  it("flags a bare menu with no question text as a question via the cursor-plus-options heuristic", () => {
    const frame = ["❯ 1. Option A", "  2. Option B", "  3. Option C"].join("\n");
    expect(classifyFrame(frame)).toBe("question");
  });

  it("does not flag a plain numbered list with no menu cursor anywhere nearby as a question", () => {
    const frame = [
      "❯ complete the task...",
      "",
      "⏺ 1. File created.",
      "  2. Folders: a, b, c.",
      "  3. Storage: 10 GB available.",
      "",
      "✻ Baked for 6s · done 9:15 AM",
      "",
      "tmux focus-events off · add 'set -g focus-events on' to ~/.tmux.conf",
      "────────",
      "❯ delete the file hello.md",
      "────────",
      "  bypass permissions on (shift+tab to cycle) · ← for agents",
    ].join("\n");
    expect(classifyFrame(frame)).toBe("complete");
  });

  it("treats an idle footer as complete", () => {
    const frame = ["Done rewriting the module.", "", "> ", "? for shortcuts   ctrl+c to exit"].join("\n");
    expect(classifyFrame(frame)).toBe("complete");
  });

  it("treats the '⧉  <name>' active-reference footer (Claude Code 2.1.252+) as chrome, not a menu/content line", () => {
    const frame = ["Done.", "", "❯", "⧉  audit"].join("\n");
    expect(classifyFrame(frame)).toBe("complete");
  });

  it("treats a live 'esc to interrupt' hint as working, not complete", () => {
    const frame = ["⏺ Update(settings.toml)", "", "✻ Cooking for 4s (esc to interrupt)"].join("\n");
    expect(classifyFrame(frame)).toBe("working");
  });

  it("treats a footer whose hint text ends in '?' as complete, not a question", () => {
    const frame = ["All done.", "> ", "for shortcuts, press ?"].join("\n");
    expect(classifyFrame(frame)).toBe("complete");
  });

  it("treats question-looking text above a live busy hint as still working (Claude Code's tools never read stdin — the turn isn't blocked)", () => {
    const frame = ["Overwrite existing file foo.ts? (y/n)", "esc to interrupt"].join("\n");
    expect(classifyFrame(frame)).toBe("working");
  });

  it("treats a chatty closing remark ending in '?' as complete when the prompt is empty and ready", () => {
    const frame = ["⏺ Hey! What can I help you with today?", "", "❯"].join("\n");
    expect(classifyFrame(frame)).toBe("complete");
  });

  it("treats an empty, ready input box as decisive for Claude Code even under question-sounding text", () => {
    expect(classifyFrame(["Overwrite existing file foo.ts? (y/n)", "❯"].join("\n"))).toBe("complete");
    expect(classifyFrame(["⏺ I'm ready to help. What would you like to work on?", "", "❯ "].join("\n"))).toBe(
      "complete",
    );
    expect(classifyFrame(["⏺ Do you want me to also update the tests?", "", "❯"].join("\n"))).toBe("complete");
  });

  it("still flags a genuine y/n confirmation for OpenCode, whose footer chrome is always present", () => {
    const frame = ["Overwrite existing file foo.ts? (y/n)", "❯"].join("\n");
    expect(classifyFrame(frame, "opencode")).toBe("question");
  });

  it("treats a reply ending in '?' as complete even when the prompt box shows a suggestion instead of being truly empty", () => {
    const frame = ["⏺ Ready to help.", "", "❯ continue the task"].join("\n");
    expect(classifyFrame(frame)).toBe("complete");
  });

  it("does not mistake a mid-transcript echo of what the user typed for the idle input box", () => {
    const frame = ["❯ are you ready?", "", "⏺ Ready to help.", "", "✻ Cooking for 2s (esc to interrupt)"].join("\n");
    expect(classifyFrame(frame)).toBe("working");
  });

  it("treats a still-busy turn as working even though the bottom input box is simultaneously empty and ready-looking", () => {
    const frame = [
      "❯ complete the three steps...",
      "",
      "· Percolating…",
      "",
      "────────",
      "❯",
      "────────",
      "  bypass permissions on (shift+tab to cycle) · esc to interrupt · /rc",
    ].join("\n");
    expect(classifyFrame(frame)).toBe("working");
  });

  it("treats empty output as ambiguous", () => {
    expect(classifyFrame("")).toBe("ambiguous");
  });

  it("treats plain unfinished prose as ambiguous rather than silently complete", () => {
    expect(classifyFrame("Thinking about the best way to refactor this")).toBe("ambiguous");
  });
});

describe("parseMenu", () => {
  it("parses the real 'trust this folder?' dialog — no numbers/bullets, options aligned by column alone", () => {
    const frame = [
      " Claude Code'll be able to read, edit, and execute files here.",
      "",
      " Security guide",
      "",
      " ❯ No, exit",
      "   Yes, I trust this folder",
      "",
      " Enter to confirm · Esc to cancel",
    ].join("\n");

    expect(parseMenu(frame)).toEqual({ cursorIndex: 0, count: 2 });
  });

  it("parses a numbered menu and finds the cursor mid-list", () => {
    const frame = [
      "This session is 15h 31m old and 179.4k tokens.",
      "",
      "❯ 1. Resume from summary (recommended)",
      "  2. Resume full session as-is",
      "  3. Don't ask me again",
      "",
      "Enter to confirm · Esc to cancel",
    ].join("\n");

    expect(parseMenu(frame)).toEqual({ cursorIndex: 0, count: 3 });
  });

  it("reports the cursor's own position when it isn't the first option", () => {
    const frame = ["Pick one:", "  1. Alpha", "❯ 2. Beta", "  3. Gamma"].join("\n");
    expect(parseMenu(frame)).toEqual({ cursorIndex: 1, count: 3 });
  });

  it("returns null for a plain yes/no question with no cursor line at all", () => {
    expect(parseMenu("Overwrite existing file foo.ts? (y/n)")).toBeNull();
  });

  it("returns null when there's no unambiguous single cursor line", () => {
    const frame = ["❯ what I typed earlier", "", "Some reply.", "", "❯"].join("\n");
    expect(parseMenu(frame)).toBeNull();
  });

  it("returns null when the cursor line has no sibling option (not a navigable menu)", () => {
    const frame = ["Some prose.", "❯ just one line", "More prose."].join("\n");
    expect(parseMenu(frame)).toBeNull();
  });

  it("doesn't mistake unrelated body text for a sibling just because it happens to align by column (adjacency matters, not just indentation)", () => {
    const frame = [
      "   A completely unrelated line that happens to start at the same column.",
      "",
      " ❯ No, exit",
      "   Yes, I trust this folder",
    ].join("\n");
    expect(parseMenu(frame)).toEqual({ cursorIndex: 0, count: 2 });
  });
});

describe("classifyFrame (OpenCode)", () => {
  it("treats a settled reply, idle box, and bottom status bar as complete", () => {
    const frame = [
      "  ┃",
      "  ┃  and what's 2+2",
      "  ┃",
      "",
      "     4",
      "",
      "     ▣  Build · DeepSeek V4 Pro · 2.0s",
      "",
      "  ┃",
      "  ┃",
      "  ┃",
      "  ┃  Build · DeepSeek V4 Pro DeepSeek",
      "  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
      "   /private/tmp/sample-project                                                      8.1K (1%) · $0.00  ctrl+p commands",
    ].join("\n");
    expect(classifyFrame(frame, "opencode")).toBe("complete");
  });

  it("treats the busy status bar ('esc interrupt', no 'to') as working, not complete", () => {
    const frame = [
      "  ┃",
      "  ┃  write a 200 word essay about the history of computing, take your time",
      "  ┃",
      "",
      "     The",
      "",
      "     ▣  Build · DeepSeek V4 Pro",
      "",
      "  ┃",
      "  ┃",
      "  ┃",
      "  ┃  Build · DeepSeek V4 Pro DeepSeek",
      "  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
      "   ⬝⬝⬝⬝⬝⬝⬝⬝  esc interrupt                                                          8.1K (1%) · $0.00  ctrl+p commands",
    ].join("\n");
    expect(classifyFrame(frame, "opencode")).toBe("working");
  });

  it("doesn't let a strong-question phrase from an earlier, already-answered turn misclassify a later, settled one (same class of bug fixed for Claude Code)", () => {
    const frame = [
      "  ┃",
      "  ┃  hello",
      "  ┃",
      "",
      "     Would you like me to get started on something?",
      "",
      "     ▣  Build · DeepSeek V4 Pro · 1.0s",
      "",
      "  ┃",
      "  ┃  just say hi back",
      "  ┃",
      "",
      "     Hi!",
      "",
      "     ▣  Build · DeepSeek V4 Pro · 0.5s",
      "",
      "  ┃",
      "  ┃",
      "  ┃",
      "  ┃  Build · DeepSeek V4 Pro DeepSeek",
      "  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
      "   /private/tmp/sample-project                                                      8.1K (1%) · $0.00  ctrl+p commands",
    ].join("\n");
    expect(classifyFrame(frame, "opencode")).toBe("complete");
  });
});
