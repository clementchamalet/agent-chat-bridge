/** Safety valve: never buffer an unresolved escape sequence past this size — drop a byte and resync instead of stalling forever. */
const MAX_PENDING_BYTES = 4096;

/** Must match the `rows` the pty is actually spawned with (see manager.ts) — this is what makes scroll math correct. */
const DEFAULT_ROWS = 40;

export class TerminalScreen {
  private lines: string[] = [""];
  private cursorRow = 0;
  private cursorCol = 0;
  private pending = "";
  /** Whether any content has scrolled off the top since the last resetScrollFlag() — see session switching and truncation. */
  private scrolledSinceReset = false;

  constructor(private readonly rows: number = DEFAULT_ROWS) {}

  hasScrolled(): boolean {
    return this.scrolledSinceReset;
  }

  /** Clears the scroll flag — called at each turn boundary (a prompt gets typed in), see PtyManager. */
  resetScrollFlag(): void {
    this.scrolledSinceReset = false;
  }

  push(rawChunk: string): void {
    const data = this.pending + rawChunk;
    this.pending = "";
    let i = 0;

    while (i < data.length) {
      const ch = data[i];

      if (ch !== "\x1b") {
        this.writeChar(ch!);
        i += 1;
        continue;
      }

      const rest = data.slice(i);
      if (rest.length < 2) {
        this.pending = rest;
        break;
      }

      const next = rest[1];
      if (next === "[") {
        const match = /^\x1b\[([0-9:;<=>?]*)([\x20-\x2f]*)([@-~])/.exec(rest);
        if (!match) {
          if (rest.length > MAX_PENDING_BYTES) {
            i += 1;
            continue;
          }
          this.pending = rest; // incomplete CSI sequence — wait for more bytes
          break;
        }
        this.applyCsi(match[1]!, match[3]!);
        i += match[0].length;
      } else if (next === "]") {
        const bel = rest.indexOf("\x07");
        const st = rest.indexOf("\x1b\\");
        const end = bel !== -1 ? bel + 1 : st !== -1 ? st + 2 : -1;
        if (end === -1) {
          if (rest.length > MAX_PENDING_BYTES) {
            i += 1; // terminator never showed up — resync rather than stall forever
            continue;
          }
          this.pending = rest; // incomplete OSC sequence — wait for more bytes
          break;
        }
        i += end;
      } else {
        const match = /^\x1b([\x20-\x2f]*)([\x30-\x7e])/.exec(rest);
        if (!match) {
          if (rest.length > MAX_PENDING_BYTES) {
            i += 1; // not a recognizable escape at all — resync rather than stall forever
            continue;
          }
          this.pending = rest; // incomplete escape — wait for more bytes
          break;
        }
        i += match[0].length;
      }
    }
  }

  clear(): void {
    this.lines = [""];
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.pending = "";
    this.scrolledSinceReset = false;
  }

  /** Returns the current on-screen text, trimmed of leading/trailing blank lines. */
  render(maxLines = this.rows): string {
    const trimmed = this.lines.map((l) => l.replace(/\s+$/g, ""));
    while (trimmed.length > 0 && trimmed[trimmed.length - 1] === "") trimmed.pop();
    let start = 0;
    while (start < trimmed.length && trimmed[start] === "") start++;
    return trimmed.slice(start).slice(-maxLines).join("\n");
  }

  /** Clamps a row to the valid 0..rows-1 range — real terminals clamp cursor movement/positioning rather than growing or scrolling. */
  private clampRow(row: number): number {
    return Math.max(0, Math.min(this.rows - 1, row));
  }

  private ensureRow(row: number): void {
    while (this.lines.length <= row) this.lines.push("");
  }

  /** Scrolls the screen up by one line: drop the top row, shift everything up, add a blank at the bottom. */
  private scrollUp(): void {
    this.lines.shift();
    this.lines.push("");
    this.scrolledSinceReset = true;
  }

  private writeChar(ch: string): void {
    const code = ch.charCodeAt(0);
    if (ch === "\n") {
      // Real terminals only scroll on a line feed *at* the bottom row —
      // every other cursor movement clamps instead (see clampRow).
      if (this.cursorRow >= this.rows - 1) {
        this.scrollUp();
      } else {
        this.cursorRow += 1;
        this.ensureRow(this.cursorRow);
      }
      this.cursorCol = 0;
      return;
    }
    if (ch === "\r") {
      this.cursorCol = 0;
      return;
    }
    if (ch === "\b") {
      this.cursorCol = Math.max(0, this.cursorCol - 1);
      return;
    }
    if (ch === "\t") {
      this.cursorCol = (Math.floor(this.cursorCol / 8) + 1) * 8;
      return;
    }
    if (code < 0x20) return; // other control chars (BEL, etc.) — ignore

    this.ensureRow(this.cursorRow);
    const line = this.lines[this.cursorRow] ?? "";
    const padded = line.length < this.cursorCol ? line + " ".repeat(this.cursorCol - line.length) : line;
    this.lines[this.cursorRow] = padded.slice(0, this.cursorCol) + ch + padded.slice(this.cursorCol + 1);
    this.cursorCol += 1;
  }

  private applyCsi(paramsStr: string, final: string): void {
    const params = paramsStr
      .replace(/[<=>?]/g, "")
      .split(/[:;]/)
      .filter((s) => s.length > 0)
      .map((s) => {
        const n = Number(s);
        return Number.isFinite(n) ? n : undefined;
      });
    const p1 = params[0];

    switch (final) {
      case "A":
        this.cursorRow = this.clampRow(this.cursorRow - (p1 ?? 1));
        break;
      case "B":
        this.cursorRow = this.clampRow(this.cursorRow + (p1 ?? 1));
        this.ensureRow(this.cursorRow);
        break;
      case "C":
        this.cursorCol += p1 ?? 1;
        break;
      case "D":
        this.cursorCol = Math.max(0, this.cursorCol - (p1 ?? 1));
        break;
      case "E":
        this.cursorRow = this.clampRow(this.cursorRow + (p1 ?? 1));
        this.cursorCol = 0;
        this.ensureRow(this.cursorRow);
        break;
      case "F":
        this.cursorRow = this.clampRow(this.cursorRow - (p1 ?? 1));
        this.cursorCol = 0;
        break;
      case "G":
        this.cursorCol = Math.max(0, (p1 ?? 1) - 1);
        break;
      case "H":
      case "f": {
        const row = params[0] ?? 1;
        const col = params[1] ?? 1;
        this.cursorRow = this.clampRow(row - 1);
        this.cursorCol = Math.max(0, col - 1);
        this.ensureRow(this.cursorRow);
        break;
      }
      case "J": {
        this.ensureRow(this.cursorRow);
        const mode = p1 ?? 0;
        if (mode === 0) {
          this.lines[this.cursorRow] = (this.lines[this.cursorRow] ?? "").slice(0, this.cursorCol);
          this.lines.length = this.cursorRow + 1;
        } else if (mode === 1) {
          for (let r = 0; r < this.cursorRow; r++) this.lines[r] = "";
          this.lines[this.cursorRow] = " ".repeat(this.cursorCol);
        } else {
          this.lines = this.lines.map(() => "");
        }
        break;
      }
      case "K": {
        this.ensureRow(this.cursorRow);
        const mode = p1 ?? 0;
        const line = this.lines[this.cursorRow] ?? "";
        if (mode === 0) this.lines[this.cursorRow] = line.slice(0, this.cursorCol);
        else if (mode === 1) this.lines[this.cursorRow] = " ".repeat(this.cursorCol) + line.slice(this.cursorCol);
        else this.lines[this.cursorRow] = "";
        break;
      }
      case "X": {
        this.ensureRow(this.cursorRow);
        const n = Math.max(1, p1 ?? 1);
        const line = this.lines[this.cursorRow] ?? "";
        if (this.cursorCol < line.length) {
          const end = Math.min(line.length, this.cursorCol + n);
          this.lines[this.cursorRow] =
            line.slice(0, this.cursorCol) + " ".repeat(end - this.cursorCol) + line.slice(end);
        }
        break;
      }
      default:
        break; // SGR (colors), cursor show/hide, save/restore, sync-update markers, ... — no line-buffer effect
    }
  }
}
