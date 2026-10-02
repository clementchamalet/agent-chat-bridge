import { describe, expect, it } from "vitest";
import { TerminalScreen } from "./terminalScreen.js";

describe("TerminalScreen", () => {
  it("renders plain text with no escape codes", () => {
    const screen = new TerminalScreen();
    screen.push("hello\nworld\n");
    expect(screen.render()).toBe("hello\nworld");
  });

  it("reconstructs the current frame after an Ink-style erase+repaint", () => {
    const screen = new TerminalScreen();
    screen.push("processing: hello\nDo you want to proceed? (y/n)\n");
    expect(screen.render()).toBe("processing: hello\nDo you want to proceed? (y/n)");

    screen.push("\x1b[1A\x1b[2K\x1b[1A\x1b[2K" + "All done.\n> \nfor shortcuts, press ?\n");

    const rendered = screen.render();
    expect(rendered).not.toContain("Do you want to proceed");
    expect(rendered).toBe("All done.\n>\nfor shortcuts, press ?");
  });

  it("handles an escape sequence split across two push() calls", () => {
    const screen = new TerminalScreen();
    screen.push("line one\nline two\n");
    screen.push("\x1b[1A\x1b");
    screen.push("[2Kreplaced\n");
    expect(screen.render()).toBe("line one\nreplaced");
  });

  it("consumes a charset-designation escape (ESC ( B) without printing its final byte as text", () => {
    const screen = new TerminalScreen();
    screen.push("Claude Code\x1b(B\x1b[m v2.1.252");
    expect(screen.render()).toBe("Claude Code v2.1.252");
  });

  it("consumes other ECMA-48 intermediate-byte escapes the same way (ESC # 8, ESC ) 0)", () => {
    const screen = new TerminalScreen();
    screen.push("before\x1b#8after");
    expect(screen.render()).toBe("beforeafter");

    const screen2 = new TerminalScreen();
    screen2.push("before\x1b)0after");
    expect(screen2.render()).toBe("beforeafter");
  });

  it("still consumes a plain 2-byte escape with no intermediate byte (ESC c, ESC =)", () => {
    const screen = new TerminalScreen();
    screen.push("before\x1bcafter");
    expect(screen.render()).toBe("beforeafter");
  });

  it("handles a charset-designation escape split across two push() calls", () => {
    const screen = new TerminalScreen();
    screen.push("before\x1b(");
    screen.push("Bafter");
    expect(screen.render()).toBe("beforeafter");
  });

  it("applies carriage-return overwrite (e.g. a progress counter)", () => {
    const screen = new TerminalScreen();
    screen.push("progress: 1%\rprogress: 50%\rprogress: 100%\n");
    expect(screen.render()).toBe("progress: 100%");
  });

  it("handles erase-to-end-of-screen (ESC[J)", () => {
    const screen = new TerminalScreen();
    screen.push("line one\nline two\nline three\n");
    screen.push("\x1b[2A\x1b[J");
    expect(screen.render()).toBe("line one");
  });

  it("handles ECH (erase character, CSI Pn X) — blanks characters in place without moving the cursor or shifting the rest of the line", () => {
    const screen = new TerminalScreen();
    screen.push("first line is long and later gets shortened\n");
    screen.push("\x1b[1A\x1b[11Cshort\x1b[27X");
    expect(screen.render()).toBe("first line short");
  });

  it("ECH erasing past the end of the line is a no-op, not a crash or an extension", () => {
    const screen = new TerminalScreen();
    screen.push("hi\x1b[20X");
    expect(screen.render()).toBe("hi");
  });

  it("caps rendered output to maxLines", () => {
    const screen = new TerminalScreen();
    for (let i = 0; i < 100; i++) screen.push(`line ${i}\n`);
    const rendered = screen.render(10);
    expect(rendered.split("\n")).toHaveLength(10);
    expect(rendered).toContain("line 99");
    expect(rendered).not.toContain("line 88\n");
  });

  it("clear() resets all state", () => {
    const screen = new TerminalScreen();
    screen.push("some content\n");
    screen.clear();
    expect(screen.render()).toBe("");
  });

  it("doesn't stall on a private-use CSI sequence with a non-digit prefix byte", () => {
    const screen = new TerminalScreen();
    screen.push("\x1b[>0q\x1b[chello\n");
    expect(screen.render()).toBe("hello");
  });

  it("doesn't stall on other ECMA-48 private parameter bytes (<, =)", () => {
    const screen = new TerminalScreen();
    screen.push("\x1b[<1;2;3m\x1b[=1hstill works\n");
    expect(screen.render()).toBe("still works");
  });

  it("doesn't stall on a CSI sequence with an intermediate byte (DECSCUSR cursor-style)", () => {
    const screen = new TerminalScreen();
    screen.push("\x1b[2 q\x1b[1 qhello\n");
    expect(screen.render()).toBe("hello");
  });

  it("reconstructs a real OpenCode idle-settle repaint without leaking '[1 q'/'[2 q' garbage", () => {
    const screen = new TerminalScreen(40);
    const chunk1 =
      "\x1b[?7727h\x1b(B\x1b[m\x1b[?12l\x1b[?25h\x1b[2 q\x1b[?1006l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[1;1H\x1b[1;40r\x1b[35;6H\x1b[?12l\x1b[?25h\x1b[1 q\x1b[?1006l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006h\x1b[?1000h\x1b[?1002h\x1b[?1003h";
    const chunk2 =
      "\x1b[?25l\x1b[38;5;231m\x1b[48;5;232m\x1b[H \x1b[K\x1b[39m\x1b[49m\x1b[38;5;231m\x1b[48;5;232m\r\n  \x1b[38;5;75m┃\x1b[38;5;231m\x1b[48;5;233m \x1b[114X\x1b[48;5;232m\x1b[114C  \x1b[39m\x1b[49m\x1b[38;5;231m\x1b[48;5;232m\x1b[3;1H  \x1b[38;5;75m┃\x1b[38;5;231m\x1b[48;5;233m  \x1b[38;5;255mtell me a short example joke\x1b[38;5;231m\x1b[84X\x1b[48;5;232m\x1b[84C  \x1b[39m\x1b[49m\x1b[38;5;231m\x1b[48;5;232m\x1b[4;1H  \x1b[38;5;75m┃\x1b[38;5;231m\x1b[48;5;233m \x1b[114X\x1b[48;5;232m\x1b[114C  \x1b[39m\x1b[49m\x1b[38;5;231m\x1b[48;5;232m\x1b[5;1H \x1b[K\x1b[39m\x1b[49m\x1b[38;5;231m\x1b[48;5;232m\r\n     \x1b[38;5;255mWhy do developers use dark mode? Because light attracts bugs!\x1b[38;5;231m\x1b[K\x1b[39m\x1b[49m\x1b[38;5;231m\x1b[48;5;232m\r\n \x1b[K\x1b[39m\x1b[49m\x1b[38;5;231m\x1b[48;5;232m\r\n     \x1b[38;5;75m▣\x1b[38;5;231m  \x1b[38;5;255mBuild\x1b[38;5;244m · DeepSeek V4 Pro · 1.8s\x1b[38;5;231m\x1b[K\x1b[39m\x1b[49m\x1b[38;5;231m\x1b[48;5;232m";
    const chunk3tail =
      "\x1b[38;1H  \x1b[38;5;75m╹\x1b[38;5;234m▀\x1b[38;5;231m  \x1b[39m\x1b[49m\x1b[38;5;231m\x1b[48;5;232m\x1b[39;1H   \x1b[38;5;244m/Users/example/Desktop/sample-tests\x1b[38;5;231m\x1b[37X\x1b[38;5;244m\x1b[37C7.9K (1%) · $0.00\x1b[38;5;231m  \x1b[38;5;255mctrl+p \x1b[38;5;244mcommands\x1b[38;5;231m  \x1b[39m\x1b[49m\x1b[38;5;231m\x1b[48;5;232m\x1b[40;1H \x1b[K\x1b(B\x1b[m\x1b[?12l\x1b[?25h\x1b[1 q\x1b[35;6H";

    screen.push(chunk1);
    screen.push(chunk2);
    screen.push(chunk3tail);

    const rendered = screen.render();
    expect(rendered).not.toMatch(/\[\d q/);
    expect(rendered).toContain("tell me a short example joke");
    expect(rendered).toContain("Why do developers use dark mode");
  });

  it("keeps rendering after many small updates using CSI > sequences, matching real Claude Code traffic", () => {
    const screen = new TerminalScreen();
    screen.push("\x1b[H\x1b[2Jbanner line\n");
    screen.push("\x1b[?25l\x1b[H\r\x1b[5B\x1b[38;5;231mhello\x1b[39m\x1b[?25h");
    screen.push("\x1b[>0q");
    screen.push("\x1b[?25l\x1b[H\r\x1b[7Bworld\x1b[?25h");

    const rendered = screen.render();
    expect(rendered).toContain("hello");
    expect(rendered).toContain("world");
  });

  it("scrolls once the viewport fills, instead of growing forever", () => {
    const screen = new TerminalScreen(5);
    for (let i = 0; i < 8; i++) screen.push(`line ${i}\n`);
    expect(screen.render()).toBe("line 4\nline 5\nline 6\nline 7");
  });

  it('keeps "cursor to home" meaning the current top of the viewport after scrolling, not the very first line ever printed', () => {
    const screen = new TerminalScreen(5);
    for (let i = 0; i < 8; i++) screen.push(`line ${i}\n`);
    screen.push("\x1b[H\x1b[2Boverwritten\n");

    const rendered = screen.render();
    expect(rendered).not.toContain("line 0");
    expect(rendered).not.toContain("line 1");
    expect(rendered).toContain("overwritten");
  });

  it("does not scroll on cursor-down/absolute-position past the bottom row — it clamps", () => {
    const screen = new TerminalScreen(5);
    screen.push("line 0\n");
    screen.push("\x1b[100B" + "clamped");
    expect(screen.render()).toBe("line 0\n\n\n\nclamped");
  });

  describe("hasScrolled", () => {
    it("is false when nothing has scrolled off the top yet", () => {
      const screen = new TerminalScreen(5);
      screen.push("line 0\nline 1\n");
      expect(screen.hasScrolled()).toBe(false);
    });

    it("becomes true once content actually scrolls off the top", () => {
      const screen = new TerminalScreen(3);
      for (let i = 0; i < 5; i++) screen.push(`line ${i}\n`);
      expect(screen.hasScrolled()).toBe(true);
    });

    it("resetScrollFlag clears it — a fresh turn starts with a clean slate", () => {
      const screen = new TerminalScreen(3);
      for (let i = 0; i < 5; i++) screen.push(`line ${i}\n`);
      expect(screen.hasScrolled()).toBe(true);

      screen.resetScrollFlag();
      expect(screen.hasScrolled()).toBe(false);
    });

    it("clear() also resets the flag", () => {
      const screen = new TerminalScreen(3);
      for (let i = 0; i < 5; i++) screen.push(`line ${i}\n`);
      screen.clear();
      expect(screen.hasScrolled()).toBe(false);
    });
  });
});
