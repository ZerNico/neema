/**
 * Shared by the rendered checkbox and the tick it sends, so both count the
 * same lines: a mismatch would tick the wrong task.
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

/**
 * Where the marker character of one task sits in the source (the space or x
 * between the brackets), or null when the ordinal is out of range. A tick is
 * that one character, so it merges beside anyone else's edit.
 */
export const taskMarkerOffset = (source: string, ordinal: number) => {
  const item = listTaskItems(source)[ordinal];
  if (!item) return null;
  const lines = source.split("\n");
  let offset = 0;
  for (let line = 0; line < item.line; line++) offset += lines[line]!.length + 1;
  const match = TASK_ITEM.exec(lines[item.line]!)!;
  return offset + match[1]!.length + 1;
};
