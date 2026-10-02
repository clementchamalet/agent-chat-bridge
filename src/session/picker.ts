const PAGE_SIZE = 20;

export interface PickerPage<T> {
  /** Items to render on this page, in display order. */
  items: T[];
  /** Absolute 1-based number of items[0] — items[i] is numbered startNumber + i. */
  startNumber: number;
  /** Present when items beyond this page still haven't been shown. */
  more: { number: number; remaining: number } | null;
  /** Total size of the underlying list, across all pages. */
  totalCount: number;
}

type PageRenderer<T> = (page: PickerPage<T>) => string;

interface PendingState<T> {
  items: T[];
  offset: number;
  render: PageRenderer<T>;
}

export class Picker<T> {
  private pending = new Map<string, PendingState<T>>();

  show(jid: string, list: T[], render: PageRenderer<T>): void {
    this.pending.set(jid, { items: list, offset: 0, render });
  }

  clear(jid: string): void {
    this.pending.delete(jid);
  }

  has(jid: string): boolean {
    return this.pending.has(jid);
  }

  private computePage(state: PendingState<T>): PickerPage<T> {
    const { items, offset } = state;
    const remainingTotal = items.length - offset;
    const hasMore = remainingTotal > PAGE_SIZE;
    const take = hasMore ? PAGE_SIZE - 1 : remainingTotal;
    return {
      items: items.slice(offset, offset + take),
      startNumber: offset + 1,
      more: hasMore ? { number: offset + take + 1, remaining: items.length - offset - take } : null,
      totalCount: items.length,
    };
  }

  /** The message text for whichever page is currently pending, or null if nothing is. */
  renderPage(jid: string): string | null {
    const state = this.pending.get(jid);
    return state ? state.render(this.computePage(state)) : null;
  }

  resolve(jid: string, text: string): T | "more" | null {
    const state = this.pending.get(jid);
    if (!state) return null;

    const trimmed = text.trim();
    if (!/^\d+$/.test(trimmed)) {
      this.pending.delete(jid);
      return null;
    }

    const n = Number(trimmed);
    const page = this.computePage(state);
    const revealedSoFar = page.more ? page.more.number - 1 : state.items.length;

    if (page.more && n === page.more.number) {
      state.offset = revealedSoFar;
      return "more";
    }

    this.pending.delete(jid);
    if (n < 1 || n > revealedSoFar) return null;
    return state.items[n - 1] ?? null;
  }

  peekAt(jid: string, n: number): T | null {
    const state = this.pending.get(jid);
    if (!state || n < 1 || n > state.items.length) return null;
    return state.items[n - 1] ?? null;
  }
}
