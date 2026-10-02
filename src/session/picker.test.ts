import { describe, expect, it } from "vitest";
import { Picker, type PickerPage } from "./picker.js";
import type { DiscoveredSession } from "../discovery/sessions.js";

function fakeList(n = 2): DiscoveredSession[] {
  return Array.from({ length: n }, (_, i) => ({
    engine: i % 2 === 0 ? "claude" : "opencode",
    resumeId: String.fromCharCode(97 + i), // a, b, c, ...
    directory: `/tmp/${String.fromCharCode(97 + i)}`,
    title: String.fromCharCode(65 + i),
    updatedAt: n - i,
    live: i === 0,
    tmuxSession: `wa-x-${String.fromCharCode(97 + i)}`,
    activeElsewhere: false,
  }));
}

function plainRender(page: PickerPage<DiscoveredSession>): string {
  const lines = page.items.map((s, i) => `${page.startNumber + i}. ${s.resumeId}`);
  if (page.more) lines.push(`${page.more.number}. more (${page.more.remaining})`);
  return lines.join("\n");
}

function resolveItem(picker: Picker<DiscoveredSession>, jid: string, text: string): DiscoveredSession | null {
  const pick = picker.resolve(jid, text);
  return pick === "more" ? null : pick;
}

describe("Picker<DiscoveredSession>", () => {
  it("resolves an in-range number to the matching entry", () => {
    const picker = new Picker<DiscoveredSession>();
    picker.show("jid", fakeList(), plainRender);
    expect(resolveItem(picker, "jid", "2")?.resumeId).toBe("b");
  });

  it("returns null with nothing pending", () => {
    const picker = new Picker<DiscoveredSession>();
    expect(picker.resolve("jid", "1")).toBeNull();
  });

  it("returns null for an out-of-range number", () => {
    const picker = new Picker<DiscoveredSession>();
    picker.show("jid", fakeList(), plainRender);
    expect(picker.resolve("jid", "99")).toBeNull();
  });

  it("returns null for non-numeric text", () => {
    const picker = new Picker<DiscoveredSession>();
    picker.show("jid", fakeList(), plainRender);
    expect(picker.resolve("jid", "fix the bug")).toBeNull();
  });

  it("consumes the pending list even on a failed resolve — the list only stays selectable for one message", () => {
    const picker = new Picker<DiscoveredSession>();
    picker.show("jid", fakeList(), plainRender);
    picker.resolve("jid", "not a number");
    expect(picker.resolve("jid", "1")).toBeNull();
  });

  it("keeps each jid's pending list independent", () => {
    const picker = new Picker<DiscoveredSession>();
    picker.show("jid-1", fakeList(), plainRender);
    expect(picker.resolve("jid-2", "1")).toBeNull();
    expect(resolveItem(picker, "jid-1", "1")?.resumeId).toBe("a");
  });

  describe("peekAt", () => {
    it("looks up by index without consuming the pending list", () => {
      const picker = new Picker<DiscoveredSession>();
      picker.show("jid", fakeList(), plainRender);
      expect(picker.peekAt("jid", 2)?.resumeId).toBe("b");
      expect(picker.peekAt("jid", 2)?.resumeId).toBe("b");
      expect(resolveItem(picker, "jid", "1")?.resumeId).toBe("a");
    });

    it("returns null out of range or with nothing pending", () => {
      const picker = new Picker<DiscoveredSession>();
      expect(picker.peekAt("jid", 1)).toBeNull();
      picker.show("jid", fakeList(), plainRender);
      expect(picker.peekAt("jid", 99)).toBeNull();
    });
  });

  describe('pagination ("more")', () => {
    it("reserves the last slot of a full page for more instead of an item", () => {
      const picker = new Picker<DiscoveredSession>();
      picker.show("jid", fakeList(25), plainRender);
      const page = picker.renderPage("jid")!;
      expect(page).toContain("19. s");
      expect(page).toContain("20. more (6)");
      expect(page).not.toContain("21.");
    });

    it("does not paginate a list that fits in one page", () => {
      const picker = new Picker<DiscoveredSession>();
      picker.show("jid", fakeList(20), plainRender);
      const page = picker.renderPage("jid")!;
      expect(page).toContain("20. t");
      expect(page).not.toContain("more");
    });

    it("picking the more slot advances to the next page without consuming the picker", () => {
      const picker = new Picker<DiscoveredSession>();
      picker.show("jid", fakeList(25), plainRender);
      expect(picker.resolve("jid", "20")).toBe("more");
      expect(picker.has("jid")).toBe(true);

      const next = picker.renderPage("jid")!;
      expect(next).toContain("20. t");
      expect(next).not.toContain("more");
    });

    it("still resolves a number from an earlier page after advancing", () => {
      const picker = new Picker<DiscoveredSession>();
      picker.show("jid", fakeList(25), plainRender);
      picker.resolve("jid", "20");
      expect(resolveItem(picker, "jid", "1")?.resumeId).toBe("a");
    });

    it("rejects a number that hasn't been revealed by any page yet", () => {
      const picker = new Picker<DiscoveredSession>();
      picker.show("jid", fakeList(25), plainRender);
      expect(picker.resolve("jid", "25")).toBeNull();
    });

    it("reuses the same renderer to produce each page's text", () => {
      const picker = new Picker<DiscoveredSession>();
      let calls = 0;
      picker.show("jid", fakeList(25), (page) => {
        calls++;
        return plainRender(page);
      });
      picker.renderPage("jid");
      picker.resolve("jid", "20");
      picker.renderPage("jid");
      expect(calls).toBe(2);
    });
  });
});
