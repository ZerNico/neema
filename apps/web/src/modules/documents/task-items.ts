/**
 * Shared by the rendered checkbox (client) and the ordinal patch (server), so
 * both count the same lines: a mismatch would tick the wrong task.
 */
export const TASK_ITEM = /^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\]/;

export interface TaskItem {
  line: number;
  checked: boolean;
}

/** Every task line in source order; the index in this array is the ordinal. */
export const listTaskItems = (source: string): TaskItem[] =>
  source.split("\n").flatMap((text, line) => {
    const match = TASK_ITEM.exec(text);
    return match ? [{ line, checked: match[2] !== " " }] : [];
  });

/** Rewrites exactly one line, or returns null when the ordinal is out of range. */
export const toggleTaskItem = (source: string, ordinal: number, checked: boolean) => {
  const lines = source.split("\n");
  const item = listTaskItems(source)[ordinal];
  if (!item) return null;
  lines[item.line] = lines[item.line]!.replace(TASK_ITEM, `$1[${checked ? "x" : " "}]`);
  return lines.join("\n");
};
