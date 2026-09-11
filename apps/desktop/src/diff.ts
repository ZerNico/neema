/**
 * A unified diff of one edit, for the model to check its change landed where
 * it meant it to. Line-based and deliberately plain: it has to be read by a
 * model and by a person in a transcript, not applied by a tool.
 */

const CONTEXT = 3;

interface Hunk {
  readonly beforeStart: number;
  readonly afterStart: number;
  readonly lines: string[];
}

/** Longest common subsequence table over lines; the inputs are one file. */
const lcs = (a: readonly string[], b: readonly string[]) => {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  return table;
};

type Op = { kind: " " | "-" | "+"; text: string };

const ops = (a: readonly string[], b: readonly string[]): Op[] => {
  const table = lcs(a, b);
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: " ", text: a[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      out.push({ kind: "-", text: a[i]! });
      i += 1;
    } else {
      out.push({ kind: "+", text: b[j]! });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) out.push({ kind: "-", text: a[i]! });
  for (; j < b.length; j += 1) out.push({ kind: "+", text: b[j]! });
  return out;
};

export const unifiedDiff = (path: string, before: string, after: string): string => {
  const a = before.split("\n");
  const b = after.split("\n");
  const all = ops(a, b);
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let sinceChange = 0;
  let beforeLine = 1;
  let afterLine = 1;

  for (let k = 0; k < all.length; k += 1) {
    const op = all[k]!;
    if (op.kind === " ") {
      if (current) {
        if (sinceChange < CONTEXT) {
          current.lines.push(` ${op.text}`);
          sinceChange += 1;
        } else {
          hunks.push(current);
          current = null;
        }
      }
      beforeLine += 1;
      afterLine += 1;
      continue;
    }
    if (!current) {
      const lead = Math.min(CONTEXT, k);
      current = { beforeStart: beforeLine - lead, afterStart: afterLine - lead, lines: [] };
      for (let c = k - lead; c < k; c += 1) current.lines.push(` ${all[c]!.text}`);
    }
    current.lines.push(`${op.kind}${op.text}`);
    sinceChange = 0;
    if (op.kind === "-") beforeLine += 1;
    else afterLine += 1;
  }
  if (current) hunks.push(current);

  const count = (lines: readonly string[], kinds: string) =>
    lines.filter((line) => kinds.includes(line[0]!)).length;
  const body = hunks.map(
    (hunk) =>
      `@@ -${hunk.beforeStart},${count(hunk.lines, " -")} +${hunk.afterStart},${count(hunk.lines, " +")} @@\n${hunk.lines.join("\n")}`,
  );
  return [`--- a/${path}`, `+++ b/${path}`, ...body].join("\n");
};
