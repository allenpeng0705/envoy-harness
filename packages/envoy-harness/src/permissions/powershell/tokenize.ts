/**
 * Lightweight PowerShell argv heuristic (not a full PS parser).
 * Splits on whitespace outside quotes; strips common call operators.
 */

export function tokenizePowerShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur.length > 0) {
        tokens.push(stripCallOp(cur));
        cur = "";
      }
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&") {
      if (cur.length > 0) {
        tokens.push(stripCallOp(cur));
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) tokens.push(stripCallOp(cur));
  return tokens.filter((t) => t.length > 0);
}

function stripCallOp(tok: string): string {
  return tok.replace(/^[&.]+/, "");
}
