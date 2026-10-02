const DEFAULT_LIMIT = 3500;

export function chunkMessage(text: string, limit = DEFAULT_LIMIT): string[] {
  if (!Number.isSafeInteger(limit) || limit < 16)
    throw new RangeError("Message limit must be an integer of at least 16");
  if (text.length <= limit) return [text];

  const lines = text.split("\n");
  const chunks: string[] = [];
  let current = "";
  let inFence = false;

  const pushCurrent = () => {
    if (current.length === 0) return;
    chunks.push(inFence ? `${current}\n\`\`\`` : current);
    current = inFence ? "```" : "";
  };

  for (let line of lines) {
    const isFenceMarker = /^\s*```/.test(line);
    const nextInFence: boolean = isFenceMarker ? !inFence : inFence;
    if (isFenceMarker && line.length > limit - 4) line = "```";
    const closingBudget = nextInFence ? 4 : 0;
    let candidate = current.length === 0 ? line : `${current}\n${line}`;

    if (candidate.length + closingBudget > limit && current.length > 0) {
      pushCurrent();
      candidate = current.length === 0 ? line : `${current}\n${line}`;
    }
    current = candidate;
    inFence = nextInFence;

    // A single line longer than the limit must be hard-split.
    while (current.length + closingBudget > limit) {
      let end = limit - closingBudget;
      if (/^[\uDC00-\uDFFF]$/.test(current[end] ?? "") && /^[\uD800-\uDBFF]$/.test(current[end - 1] ?? "")) end--;
      const rest = current.slice(end);
      current = current.slice(0, end);
      pushCurrent();
      current = inFence ? `${current}\n${rest}` : rest;
    }
  }
  pushCurrent();

  return chunks.filter((c) => c.length > 0);
}

export function codeFence(text: string): string {
  return `\`\`\`\n${text}\n\`\`\``;
}
