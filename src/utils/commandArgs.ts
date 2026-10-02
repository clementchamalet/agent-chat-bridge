/** Split chat arguments without executing shell syntax. */
export function commandArgs(input: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote = "";
  let started = false;
  for (const char of input) {
    if (quote) {
      if (char === quote) quote = "";
      else token += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) tokens.push(token);
      token = "";
      started = false;
    } else {
      token += char;
      started = true;
    }
  }
  if (quote) throw new Error("Unclosed quote in command arguments");
  if (started) tokens.push(token);
  return tokens;
}
