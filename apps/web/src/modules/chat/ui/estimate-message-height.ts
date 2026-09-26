import type { DisplayMessage } from "./message-list.tsx";

// Measured from the rendered transcript (text-sm, Geist): a guess the list
// corrects once a row mounts, so close beats exact. A flat guess made every
// row entering from above resize by about 60px, which the list then offset
// by moving the scroll position under the reader.
const LINE = 22.75;
const CHAR = 6.6;
/** The assistant row's padding plus its action row. */
const ANSWER_CHROME = 60;
/** The user row's padding, bubble padding and action row. */
const QUESTION_CHROME = 76;
const BLOCK_GAP = 12;
/** Code blocks, lists and tables sit a little further apart. */
const WIDE_GAP = 16;
const HEADING = 32;
/** A code block's frame and header; its body is padded lines, capped by Streamdown. */
const CODE_BLOCK = 62;
const CODE_PADDING = 32;
const CODE_LINE = 20;
const CODE_MAX_BODY = 400;
const TABLE = 58;
const TABLE_ROW = 35;
const LIST_ITEM = 8;
const DAY_DIVIDER = 32;
/** One collapsed activity row: a tool call, reasoning, a compaction or a file. */
const ACTIVITY = 40;
/** A citation chip is about this many characters wide. */
const CHIP_CHARS = 22;

const FENCE = /^\s*(```|~~~)/;
const TABLE_LINE = /^\s*\|/;
const TABLE_RULE = /^\s*\|[\s:|-]+\|?\s*$/;
const HEADING_LINE = /^\s*#{1,6}\s/;
const LIST_LINE = /^\s*([-*+]|\d+[.)])\s/;

/** The characters a line of markdown shows: link targets and markers take no room. */
const visibleLength = (text: string) =>
  text
    .replace(/\[\^\d+\]/g, " ".repeat(CHIP_CHARS))
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "").length;

function markdownHeight(content: string, textWidth: number): number {
  const perLine = Math.max(10, Math.floor(textWidth / CHAR));
  const lines = content.split("\n");
  let height = 0;
  let gap = 0;
  let paragraph = "";
  const block = (size: number, wide = false) => {
    height += (height > 0 ? Math.max(gap, wide ? WIDE_GAP : BLOCK_GAP) : 0) + size;
    gap = wide ? WIDE_GAP : BLOCK_GAP;
  };
  const flush = () => {
    const text = paragraph.trim();
    paragraph = "";
    if (text) block(Math.ceil(visibleLength(text) / perLine) * LINE);
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (FENCE.test(line)) {
      flush();
      let codeLines = 0;
      for (index += 1; index < lines.length && !FENCE.test(lines[index]!); index += 1)
        codeLines += 1;
      block(CODE_BLOCK + Math.min(CODE_PADDING + codeLines * CODE_LINE, CODE_MAX_BODY), true);
    } else if (TABLE_LINE.test(line)) {
      flush();
      let rows = 0;
      for (; index < lines.length && TABLE_LINE.test(lines[index]!); index += 1)
        if (!TABLE_RULE.test(lines[index]!)) rows += 1;
      index -= 1;
      block(TABLE + rows * TABLE_ROW, true);
    } else if (LIST_LINE.test(line)) {
      flush();
      let size = 0;
      for (; index < lines.length && LIST_LINE.test(lines[index]!); index += 1)
        size += Math.ceil(visibleLength(lines[index]!.trim()) / perLine) * LINE + LIST_ITEM;
      index -= 1;
      block(size, true);
    } else if (HEADING_LINE.test(line)) {
      flush();
      block(HEADING);
      gap = 8;
    } else if (!line.trim()) flush();
    else paragraph += ` ${line}`;
  }
  flush();
  return height;
}

/**
 * A row's likely height before it has been measured, for the virtualizer.
 * `rowWidth` is the transcript column's width; text wraps inside its padding.
 */
export function estimateMessageHeight(message: DisplayMessage, rowWidth: number): number {
  const textWidth = rowWidth - 2 * 16;
  const divider = message.dayLabel ? DAY_DIVIDER : 0;
  if (message.role === "user") {
    // The bubble wraps at 80% of the column, inside its own padding.
    const bubbleText = textWidth * 0.8 - 2 * 16;
    const perLine = Math.max(10, Math.floor(bubbleText / CHAR));
    const lines = message.content
      .split("\n")
      .reduce((sum, line) => sum + Math.max(1, Math.ceil(visibleLength(line) / perLine)), 0);
    const files = (message.attachments?.length ?? 0) > 0 ? ACTIVITY : 0;
    return QUESTION_CHROME + lines * LINE + files + divider;
  }
  const activities =
    message.toolActivities.length +
    (message.compactionActivities?.length ?? 0) +
    (message.files?.length ?? 0) +
    (message.reasoningSeen ? 1 : 0);
  return (
    ANSWER_CHROME + markdownHeight(message.content, textWidth) + activities * ACTIVITY + divider
  );
}
