import { describe, expect, it } from "vitest";
import {
  compactToolActivity,
  extractEffort,
  extractElapsed,
  extractElapsedBusy,
  extractModelName,
  extractReply,
  extractTokens,
  summarizeFrame,
} from "./frameSummary.js";

const CLAUDE_CODE_FRAME = `╭─── Claude Code v2.1.210 ─────────────────────────────────────────────────────────────────────────────────────────────╮
│                                                    │ Tips for getting started                                        │
│                Welcome back Example!               │ Ask Claude to create a new app or clone a repository            │
│                                                    │ ─────────────────────────────────────────────────────────────── │
│                       ▐▛███▜▌                      │ What's new                                                      │
│                      ▝▜█████▛▘                     │ Added a live elapsed-time counter to the collapsed tool summar… │
│                        ▘▘ ▝▝                       │ Added a startup warning for \`Write(path)\`, \`NotebookEdit(path)… │
│      Sonnet 5 · Claude Pro ·                       │ Fixed \`isolation: 'worktree'\` subagents being able to run git-… │
│      developer@example.org's Organization     │ /release-notes for more                                         │
│                     ~/Projects                     │                                                                 │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯

 ▎ Keep working from anywhere
 ▎ Check progress or reply to any session from the mobile app, desktop app, or
 ▎ https://claude.ai/code/session_example. To keep a session in this terminal only, run /remote-control

❯ Hello

⏺ Hello! What can I help you with today?

✻ Worked for 2s

                                                                                                       ● high · /effort
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)                                                              /rc active`;

describe("summarizeFrame", () => {
  it("strips the persistent welcome banner and footer chrome from a Claude Code terminal frame", () => {
    const summary = summarizeFrame(CLAUDE_CODE_FRAME);

    expect(summary).toContain("Hello");
    expect(summary).toContain("Hello! What can I help you with today?");

    expect(summary).not.toContain("Tips for getting started");
    expect(summary).not.toContain("Welcome back");
    expect(summary).not.toContain("What's new");
    expect(summary).not.toContain("Keep working from anywhere");
    expect(summary).not.toContain("remote-control");
    expect(summary).not.toContain("Organization");
    expect(summary).not.toContain("bypass permissions on");
    expect(summary).not.toContain("/effort");
    expect(summary).not.toContain("/rc active");
    expect(summary).not.toMatch(/[╭╮╰╯]/);
  });

  it("is dramatically shorter than the raw frame", () => {
    const summary = summarizeFrame(CLAUDE_CODE_FRAME);
    expect(summary.length).toBeLessThan(CLAUDE_CODE_FRAME.length / 3);
  });

  it("returns an empty string when the whole frame is chrome", () => {
    expect(summarizeFrame("╭───╮\n│ Tips for getting started │\n╰───╯")).toBe("");
  });

  it("leaves plain conversational text untouched", () => {
    expect(summarizeFrame("Do you want to proceed? (y/n)")).toBe("Do you want to proceed? (y/n)");
  });

  it("strips Claude Code's rotating tmux tips", () => {
    const frame = [
      "Hey! What are you working on today?",
      "",
      "                      tmux detected · scroll with PgUp/PgDn · or add 'set -g mouse on' to ~/.tmux.conf for wheel scroll",
    ].join("\n");
    expect(summarizeFrame(frame)).toBe("Hey! What are you working on today?");

    const frame2 = [
      "Hey! What are you working on today?",
      "",
      "                   tmux focus-events off · add 'set -g focus-events on' to ~/.tmux.conf and reattach for focus tracking",
    ].join("\n");
    expect(summarizeFrame(frame2)).toBe("Hey! What are you working on today?");
  });

  it("strips Unicode spinner labels", () => {
    const frame = ["The task is complete.", "", "✻ Cooked🍳 for 3s"].join("\n");
    expect(summarizeFrame(frame)).toBe("The task is complete.");
  });

  it("strips the thinking-time spinner line's extended '· done <time>' variant too", () => {
    const frame1 = ["All done.", "", "✻ Baked for 10s · done 9:15 AM"].join("\n");
    expect(summarizeFrame(frame1)).toBe("All done.");

    const frame2 = ["All done.", "", "✻ Cooked for 3s · done Monday 11:28 PM"].join("\n");
    expect(summarizeFrame(frame2)).toBe("All done.");
  });

  it("strips the effort footer at xhigh/max, not just low/medium/high", () => {
    const frame = ["All done.", "", "                                                       ● xhigh · /effort"].join(
      "\n",
    );
    expect(summarizeFrame(frame)).toBe("All done.");

    const frame2 = ["All done.", "", "                                                       ● max · /effort"].join(
      "\n",
    );
    expect(summarizeFrame(frame2)).toBe("All done.");
  });
});

describe("metadata extraction", () => {
  it("extracts effort level", () => {
    expect(extractEffort(CLAUDE_CODE_FRAME)).toBe("high");
    expect(extractEffort("no effort footer here")).toBeNull();
  });

  it("extracts xhigh and max, not just low/medium/high", () => {
    expect(extractEffort("● xhigh · /effort")).toBe("xhigh");
    expect(extractEffort("● max · /effort")).toBe("max");
  });

  it("extracts elapsed time regardless of Claude Code's randomized cooking verb", () => {
    expect(extractElapsed("✻ Worked for 2s")).toBe("2s");
    expect(extractElapsed("✻ Cooked🍳 for 12s")).toBe("12s");
    expect(extractElapsed("✻ Baked for 1s")).toBe("1s");
    expect(extractElapsed("nothing here")).toBeNull();
  });

  it("extracts the model name from the boot banner", () => {
    expect(extractModelName(CLAUDE_CODE_FRAME)).toBe("Sonnet 5");
    expect(extractModelName("no model mentioned")).toBeNull();
  });

  it("extracts the model name when the banner also states the effort level", () => {
    expect(extractModelName("▝▜██████▀  Sonnet 5 with high effort · Claude Pro")).toBe("Sonnet 5");
    expect(extractModelName("Opus 5 with xhigh effort · Claude Team")).toBe("Opus 5");
  });

  it("extracts Fable, the third current model family name", () => {
    expect(extractModelName("Fable 5 · Claude Pro")).toBe("Fable 5");
  });

  it("extracts elapsed time and token count from the newer busy-spinner shape", () => {
    expect(extractElapsedBusy("✽ Ionizing… (2m 15s · ↓ 3.4k tokens)")).toBe("2m 15s");
    expect(extractTokens("✽ Ionizing… (2m 15s · ↓ 3.4k tokens)")).toBe("3.4k tokens");
    expect(extractElapsedBusy("nothing here")).toBeNull();
    expect(extractTokens("nothing here")).toBeNull();
  });
});

describe("extractReply", () => {
  it("builds a clean meta header and strips the echoed input + response marker", () => {
    const { meta, body } = extractReply(CLAUDE_CODE_FRAME, "Sonnet 5");

    expect(meta).toBe("Sonnet 5 · high · 2s");
    expect(body).not.toContain("❯ Hello");
    expect(body).not.toMatch(/^⏺/m);
    expect(body).not.toContain("Worked for 2s");
    expect(body).toContain("Hello! What can I help you with today?");
    expect(body.trim()).not.toMatch(/[>❯]\s*$/);
  });

  it("strips a trailing empty prompt box from the body", () => {
    const { body } = extractReply("⏺ All done rewriting the module.\n\n❯");
    expect(body).toBe("All done rewriting the module.");
  });

  it("strips a trailing prompt box even when Claude Code fills it with a suggestion instead of leaving it blank", () => {
    const { body } = extractReply("⏺ Ready to help.\n\n❯ continue the task");
    expect(body).toBe("Ready to help.");
  });

  it("isolates just the latest turn when older turns are still visible on screen", () => {
    const frame = [
      "⏺ Hello! What can I help you with today?",
      "",
      "❯ are you ready?",
      "",
      "⏺ Ready to help. What should we work on?",
      "",
      "❯",
    ].join("\n");

    const { body } = extractReply(frame);

    expect(body).toBe("Ready to help. What should we work on?");
    expect(body).not.toContain("Hello! What can I help you with today?");
    expect(body).not.toContain("are you ready?");
  });

  it("still isolates the latest turn across three accumulated turns", () => {
    const frame = ["❯ one", "", "⏺ First.", "", "❯ two", "", "⏺ Second.", "", "❯ three", "", "⏺ Third.", "", "❯"].join(
      "\n",
    );

    const { body } = extractReply(frame);

    expect(body).toBe("Third.");
    expect(body).not.toContain("First.");
    expect(body).not.toContain("Second.");
  });

  it("skips wrapped continuation lines of a long echoed input, not just its first physical line", () => {
    const frame = [
      "❯ Complete three steps. Create a Markdown file, then list the project folders and report the available",
      "  disk space for the current workspace",
      "",
      "  Ran 3 shell commands",
      "",
      "⏺ 1. File created.",
      "",
      "❯",
    ].join("\n");

    const { body } = extractReply(frame);

    expect(body).not.toContain("disk space");
    expect(body).not.toContain("current workspace");
    expect(body).toContain("1. File created.");
  });

  it("recovers just the reply even when the echo's own '❯' line has already scrolled off", () => {
    const frame = [
      "  about the project dependencies and their versions.",
      "",
      "  PART 3 — another paragraph of the input without a prompt marker",
      "  because the first line has already scrolled off the screen.",
      "",
      "  Last paragraph of the input before the reply.",
      "",
      "⏺ This is the reply to deliver.",
      "",
      "❯",
    ].join("\n");

    const { body } = extractReply(frame);

    expect(body).toBe("This is the reply to deliver.");
    expect(body).not.toContain("PART 3");
    expect(body).not.toContain("dependencies");
    expect(body).not.toContain("Last paragraph");
  });

  it("falls back to the last known effort level when the current frame doesn't show it", () => {
    const { meta } = extractReply("Hi there", "Sonnet 5", "high");
    expect(meta).toBe("Sonnet 5 · high");
  });

  it("falls back to no meta line when nothing is extractable", () => {
    const { meta, body } = extractReply("Do you want to proceed? (y/n)");
    expect(meta).toBe("");
    expect(body).toBe("Do you want to proceed? (y/n)");
  });

  it("keeps the prose and the one-line tool summaries but drops inlined diff hunks", () => {
    const frame = [
      "⏺ The configuration is ready. I will update settings.toml and check",
      "  the installation.",
      "",
      "⏺ Update(settings.toml)",
      "  ⎿  Added 6 lines, removed 1 line",
      '       7      title = "Example configuration"',
      "       8      [options]",
      "       9          enabled = true",
      "      10    -    limit = 10",
      "      11    +    # Updated example setting",
      "      15    +    limit = 20",
      '      16          path = "src"',
      "",
      "  Ran 2 shell commands",
      "",
      "❯",
    ].join("\n");

    const { body } = extractReply(frame);

    expect(body).toContain("The configuration is ready");
    expect(body).toContain("Update(settings.toml)");
    expect(body).toContain("Added 6 lines, removed 1 line");
    expect(body).toContain("Ran 2 shell commands");
    expect(body).not.toContain("Example configuration");
    expect(body).not.toContain("enabled = true");
    expect(body).not.toContain("Updated example setting");
  });

  it("drops a Bash tool's multi-line command/output dump under its own '⎿' head, not just its first physical row", () => {
    const frame = [
      "⏺ Bash(cd /tmp/example-project && echo manifest check)",
      '  ⎿  $ cd /tmp/example-project echo "=== manifest check ==="',
      '     sha256sum manifest.yaml 2>/dev/null || shasum -a 256 manifest.yaml cat manifest.sha256 echo "=== new sample results ==="',
      '     ls -la results/*sample.json | grep -E "INPUT|OUTPUT"',
      "",
      "The file exists. The next step is ready.",
      "",
      "❯",
    ].join("\n");

    const { body } = extractReply(frame);

    expect(body).not.toContain("sha256sum manifest.yaml");
    expect(body).not.toContain("ls -la results");
    expect(body).toContain("Bash(cd /tmp/example-project && echo manifest check)");
    expect(body).toContain("The file exists. The next step is ready.");
  });

  it("moves busy-spinner timing and tokens into metadata", () => {
    const frame = ["⏺ Step one is complete.", "", "✽ Ionizing… (2m 15s · ↓ 3.4k tokens)"].join("\n");

    const { body, meta } = extractReply(frame, "Sonnet 5", "high");

    expect(body).not.toContain("Ionizing");
    expect(body).not.toContain("↓");
    expect(body).toContain("Step one is complete.");
    expect(meta).toBe("Sonnet 5 · high · 2m 15s · 3.4k tokens");
  });

  it("drops a diff line's wrapped continuation too, not just its own gutter-prefixed row", () => {
    const frame = [
      "⏺ Update(report.md)",
      "  ⎿  Added 4 lines",
      " 1129  +| generated files | Some files were excluded from this example report because they contain",
      "       +temporary output and cached build artifacts |",
      " 1130  +| project files | The report contains files from the selected project directory and its",
      "       +subdirectories |",
      " 1132  +| skipped files | Files outside the selected directory are excluded from the report",
      "       + |",
      "",
      "  Ran 1 shell command",
      "",
      "❯",
    ].join("\n");

    const { body } = extractReply(frame);

    expect(body).not.toContain("temporary output and cached build artifacts");
    expect(body).not.toContain("subdirectories");
    expect(body).toContain("Update(report.md)");
    expect(body).toContain("Ran 1 shell command");
  });

  it("does not eat an ordinary indented markdown bullet list from the agent's own prose", () => {
    const frame = ["⏺ Here are the options:", "", "  - first point", "  - second point", "", "❯"].join("\n");

    const { body } = extractReply(frame);

    expect(body).toContain("first point");
    expect(body).toContain("second point");
  });

  it("drops a new file's entire inlined content under 'Wrote N lines to <path>', not just diff hunks", () => {
    const frame = [
      "⏺ The example script is ready.",
      "",
      "  ⎿  Wrote 189 lines to src/example.py",
      "     1  #!/usr/bin/env python3",
      '     2  """Example report generator"""',
      "     5",
      "     6  EXAMPLE REPORT OUTPUT.",
      "     7",
      "     8  Reuse the existing inputs :",
      "     ... +180 lines",
      "",
      "The example check passed. The next step is ready.",
      "",
      "❯",
    ].join("\n");

    const { body } = extractReply(frame);

    expect(body).toContain("The example script is ready.");
    expect(body).toContain("Wrote 189 lines to src/example.py");
    expect(body).toContain("The example check passed. The next step is ready.");
    expect(body).not.toContain("#!/usr/bin/env python3");
    expect(body).not.toContain("EXAMPLE REPORT OUTPUT");
    expect(body).not.toContain("Reuse the existing inputs");
    expect(body).not.toContain("+180 lines");
  });

  it("rejoins a word-wrapped paragraph's physical rows into one line instead of leaving mid-sentence breaks", () => {
    const frame = [
      "⏺ 4. EXCLUDED FILES. Some generated files are excluded from the report because of the",
      "   time limit per repository. Their results are not included.",
      "",
      "5. REMAINING FILES. The report includes the successfully processed files.",
      "",
      "RESULTS. The report lists the inputs, summarizes the processed files, and describes the",
      "remaining work for the next run.",
      "",
      "❯",
    ].join("\n");

    const { body } = extractReply(frame);

    expect(body).toContain(
      "4. EXCLUDED FILES. Some generated files are excluded from the report because of the time limit per repository. Their results are not included.",
    );
    expect(body).toContain(
      "RESULTS. The report lists the inputs, summarizes the processed files, and describes the remaining work for the next run.",
    );
    expect(body).toContain("5. REMAINING FILES. The report includes the successfully processed files.");
  });

  it("does not rejoin a genuinely new sentence/list item into the previous line just because it lacks a blank line separator", () => {
    const frame = ["⏺ Here is the summary:", "1. First item without final punctuation", "2. Second item", "", "❯"].join(
      "\n",
    );

    const { body } = extractReply(frame);

    expect(body).toContain("1. First item without final punctuation");
    expect(body).toContain("2. Second item");
    expect(body).not.toContain("punctuation 2. Second item");
  });

  it("italicizes tool-call lines (WhatsApp's _..._ markdown) but leaves the agent's own prose plain", () => {
    const frame = [
      "⏺ Read 1 file",
      "",
      "⏺ Write(hello.md)",
      "  ⎿",
      "",
      "  Searched for 1 pattern, ran 1 shell command",
      "",
      "⏺ Finished with the same results:",
      "",
      '  1. File rewritten with "hello".',
      "",
      "❯",
    ].join("\n");

    const { body } = extractReply(frame);

    expect(body).toContain("_Read 1 file_");
    expect(body).toContain("_Write(hello.md)_");
    expect(body).toContain("_⎿_");
    expect(body).toContain("_Searched for 1 pattern, ran 1 shell command_");
    expect(body).toContain("Finished with the same results:");
    expect(body).not.toContain("_Finished with the same results:_");
    expect(body).toContain('1. File rewritten with "hello".');
    expect(body).not.toContain('_1. File rewritten with "hello"._');
  });

  it("keeps a slash command's own '⎿' result as the body instead of swallowing it as wrapped echo text", () => {
    const frame = [
      "❯ first message",
      "",
      "⏺ First reply.",
      "",
      "❯ /compact",
      "  ⎿  Compacted (ctrl+o to see full summary)",
      "",
      "❯",
    ].join("\n");

    const { body } = extractReply(frame);

    expect(body).toBe("_⎿  Compacted (ctrl+o to see full summary)_");
    expect(body).not.toContain("first message");
    expect(body).not.toContain("First reply");
  });

  it("strips the '⧉  <name>' active-reference footer (Claude Code 2.1.252+) instead of leaking it — and the empty prompt above it — into the body", () => {
    const frame = ["⏺ Done.", "", "❯", "  ⏵⏵ bypass permissions on (shift+tab to cycle)", "  ⧉  audit"].join("\n");

    const { body } = extractReply(frame);

    expect(body).toBe("Done.");
  });

  it("drops a compact diff hunk with no space between the +/- marker and the content", () => {
    const frame = [
      "⏺ Write(hello.md)",
      "  ⎿  Added 1 line, removed 1 line",
      "      1 -hello world",
      "      1 +hello",
      "",
      "⏺ File updated.",
      "",
      "❯",
    ].join("\n");

    const { body } = extractReply(frame);

    expect(body).toContain("Write(hello.md)");
    expect(body).toContain("Added 1 line, removed 1 line");
    expect(body).toContain("File updated.");
    expect(body).not.toContain("hello world");
  });
});

describe("compactToolActivity", () => {
  it("collapses italicized tool-call lines into one compact count line, ahead of the plain-text reply", () => {
    const frame = [
      "⏺ Read 1 file",
      "",
      "⏺ Write(hello.md)",
      "  ⎿",
      "",
      "  Searched for 1 pattern, ran 1 shell command",
      "",
      "⏺ Finished with the same results:",
      "",
      "❯",
    ].join("\n");
    const { body } = extractReply(frame);

    const compacted = compactToolActivity(body);

    expect(compacted).toBe(
      "> _1 file read, 1 file edited, 1 search, 1 command run_\n\nFinished with the same results:",
    );
  });

  it("counts several calls of the same kind together, plural phrasing", () => {
    const compacted = compactToolActivity(
      ["_Write(a.ts)_", "_Write(b.ts)_", "_Write(c.ts)_", "Three files updated."].join("\n"),
    );
    expect(compacted).toBe("> _3 files edited_\n\nThree files updated.");
  });

  it("leaves plain prose with no tool-call lines completely untouched", () => {
    expect(compactToolActivity("Hello! What can I help you with today?")).toBe(
      "Hello! What can I help you with today?",
    );
  });

  it("produces just the summary line when a chunk is pure tool activity with no prose yet", () => {
    expect(compactToolActivity("_Bash(npm test)_")).toBe("> _1 command run_");
  });

  it("keeps an italicized meta footer (model · effort · time) as plain trailing text, not tool activity", () => {
    const compacted = compactToolActivity("_Write(hello.md)_\nReply.\n_Sonnet 5 · high · 4s_");
    expect(compacted).toBe("> _1 file edited_\n\nReply.\n_Sonnet 5 · high · 4s_");
  });

  it("is a no-op on a question/menu frame with no tool-call lines", () => {
    const menu = "Which file do you want?\n1. a.ts\n❯ 2. b.ts\n3. c.ts";
    expect(compactToolActivity(menu)).toBe(menu);
  });
});

describe("extractReply (OpenCode)", () => {
  it("isolates just the latest turn across three accumulated turns, including one with tool calls, and drops the echo", () => {
    const frame = [
      "  ┃",
      "  ┃  hello, who are you",
      "  ┃",
      "",
      "     The agent is ready to process the next task.",
      "",
      "     ▣  Build · DeepSeek V4 Pro · 2.9s",
      "",
      "  ┃",
      "  ┃  and what's 2+2",
      "  ┃",
      "",
      "     4",
      "",
      "     ▣  Build · DeepSeek V4 Pro · 2.0s",
      "",
      "  ┃",
      "  ┃  create a file called test.txt with the content 'hello opencode' then read it back",
      "  ┃",
      "",
      "  ┃",
      "  ┃  # Wrote test.txt",
      "  ┃",
      "  ┃   1 hello opencode",
      "  ┃",
      "",
      "     → Read test.txt",
      "",
      "     Done. test.txt contains hello opencode.",
      "",
      "     ▣  Build · DeepSeek V4 Pro · 4.5s",
      "",
      "  ┃",
      "  ┃",
      "  ┃",
      "  ┃  Build · DeepSeek V4 Pro DeepSeek",
      "  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
      "   /private/tmp/sample-project                                                      8.1K (1%) · $0.00  ctrl+p commands",
    ].join("\n");

    const { meta, body } = extractReply(frame, null, null, "opencode");

    expect(meta).toBe("DeepSeek V4 Pro · 4.5s");
    expect(body).toBe("_Write(test.txt)_\n\n_Read(test.txt)_\n\n     Done. test.txt contains hello opencode.");
    expect(body).not.toContain("hello, who are you");
    expect(body).not.toContain("what's 2+2");
    expect(body).not.toContain("create a file called test.txt");
  });

  it("synthesizes boxed 'Wrote'/'$ command' tool calls and unboxed '→'/'✱' summaries into Claude Code's own italic ToolName(args) shape", () => {
    const frame = [
      "  ┃",
      "  ┃  run 'ls -la' and 'echo hello' then search for the word hello in this directory using grep",
      "  ┃",
      "",
      "     + Thought: 1.4s",
      "",
      "  ┃",
      "  ┃  $ ls -la",
      "  ┃",
      "  ┃  total 8",
      "  ┃  drwxr-xr-x@  4 example  wheel   128 Sep  2 19:05 .",
      "  ┃",
      "",
      "  ┃",
      "  ┃  $ echo hello",
      "  ┃",
      "  ┃  hello",
      "  ┃",
      "",
      '     ✱ Grep "hello"',
      "",
      '     No matches for "hello" found in this directory.',
      "",
      "     ▣  Build · DeepSeek V4 Pro · 7.1s",
    ].join("\n");

    const { body } = extractReply(frame, null, null, "opencode");

    expect(body).toContain("_Bash(ls -la)_");
    expect(body).toContain("_Bash(echo hello)_");
    expect(body).toContain("_Grep(hello)_");
    expect(body).toContain('No matches for "hello" found in this directory.');
    expect(body).not.toContain("drwxr-xr-x");
    expect(body).not.toContain("total 8");
    expect(body).not.toContain("Thought:");
  });

  it("synthesizes a boxed '← Edit <file>' tool call into Claude Code's own italic Edit(args) shape, dropping its raw diff detail", () => {
    const frame = [
      "  ┃",
      "  ┃  replace hello with greetings in notes.md",
      "  ┃",
      "",
      "  ┃",
      "  ┃  ← Edit notes.md",
      "  ┃",
      "  ┃    1 - hello",
      "  ┃    1 + greetings",
      "  ┃",
      "",
      "     Done. notes.md now contains greetings.",
      "",
      "     ▣  Build · DeepSeek V4 Pro · 4.3s",
    ].join("\n");

    const { body } = extractReply(frame, null, null, "opencode");

    expect(body).toContain("_Edit(notes.md)_");
    expect(body).toContain("Done. notes.md now contains greetings.");
    expect(body).not.toContain("1 - hello");
    expect(body).not.toContain("1 + greetings");
  });

  it("falls back to the whole chrome-stripped frame instead of an empty body when there's nothing but a tool call (edge case)", () => {
    const frame = ["  ┃", "  ┃  do something", "  ┃", "", "  ┃", "  ┃  # Wrote x.txt", "  ┃", "  ┃   1 x", "  ┃"].join(
      "\n",
    );
    const { body } = extractReply(frame, null, null, "opencode");
    expect(body.trim().length).toBeGreaterThan(0);
  });

  it("recognizes the idle box's '--auto'-spawned footer variant ('Build auto · ...', not just 'Build · ...')", () => {
    const frame = [
      "  ┃",
      "  ┃  identify yourself and the model you are using",
      "  ┃",
      "",
      "     This is OpenCode running the deepseek/deepseek-v4-pro model.",
      "",
      "     ▣  Build · DeepSeek V4 Pro · 2.5s",
      "",
      "  ┃",
      "  ┃",
      "  ┃",
      "  ┃  Build auto · DeepSeek V4 Pro DeepSeek",
      "  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
      "   /Users/example/Desktop/sample-tests                                     7.9K (1%) · $0.00  ctrl+p commands",
    ].join("\n");

    const { meta, body } = extractReply(frame, null, null, "opencode");

    expect(meta).toBe("DeepSeek V4 Pro · 2.5s");
    expect(body).toBe("This is OpenCode running the deepseek/deepseek-v4-pro model.");
    expect(body).not.toContain("identify yourself");
  });
});
