import { describe, expect, it } from "vitest";
import { countToolCalls, formatAgentContent, formatDuration, formatRunFooter } from "./outbound.js";

describe("WhatsApp outbound formatter", () => {
  it("keeps only the agent intent and aggregates tool calls into one quote", () => {
    const formatted = formatAgentContent(
      [
        "✻ Brewed for 2m 10s · done 2:28 PM",
        "new task? /clear to save 12.5k tokens",
        "_Bash(npm test)_",
        "_Write(src/tables.py)_",
        "_⎿ Added 12 lines",
        "raw command output that must not leak",
        "",
        "The requested change is complete.",
      ].join("\n"),
    );

    expect(formatted).toBe("> (2 commands run)\n\nThe requested change is complete.");
    expect(formatted).not.toContain("Bash(");
    expect(formatted).not.toContain("tokens");
    expect(formatted).not.toContain("raw command output");
  });

  it("does not discard a legitimate WhatsApp quote from the agent", () => {
    expect(formatAgentContent("> Important: keep the migration reversible.")).toBe(
      "> Important: keep the migration reversible.",
    );
  });

  it("removes old manager metadata so there is only one footer", () => {
    expect(formatAgentContent("Reply.\n\n_DeepSeek V4 Pro · 4.5s_")).toBe("Reply.");
  });

  it("formats a stable standard footer", () => {
    expect(formatRunFooter("DeepSeek V4 Pro", "light", 27 * 60_000 + 9_000)).toBe("_DeepSeek V4 Pro · light · 27m_");
    expect(formatDuration(9_000)).toBe("9s");
  });

  it("omits unavailable effort metadata", () => {
    expect(formatRunFooter("gpt-example", "n/a", 9_000)).toBe("_gpt-example · 9s_");
    expect(formatRunFooter("gpt-example", null, 9_000)).toBe("_gpt-example · 9s_");
  });

  it("counts summary clauses without exposing their technical names", () => {
    expect(countToolCalls("_Ran 41 shell commands_")).toBe(41);
    expect(formatAgentContent("_Ran 41 shell commands_\nDone.")).toBe("> (41 commands run)\n\nDone.");
  });
});
