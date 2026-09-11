export interface MentionToken {
  start: number;
  end: number;
  query: string;
}

const escape = (trigger: string) => trigger.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

/**
 * The trigger-prefixed word the caret currently sits at the end of, or null.
 *
 * A trigger only opens a list at the start of a word, so `issue#5` and a URL's
 * slashes are ordinary text. The caret must be a collapsed selection sitting at
 * the end of the token with nothing but whitespace after it, so editing in the
 * middle of an existing sentence never pops a list open.
 */
export function matchMentionToken(
  value: string,
  start: number,
  end: number,
  trigger: string,
): MentionToken | null {
  if (
    start !== end ||
    start < 0 ||
    start > value.length ||
    (start < value.length && !/\s/u.test(value[start]!))
  )
    return null;
  const match = value
    .slice(0, start)
    .match(new RegExp(String.raw`(?:^|\s)${escape(trigger)}([\p{L}\p{N}_-]{0,64})$`, "u"));
  if (!match) return null;
  return { start: start - match[1]!.length - trigger.length, end: start, query: match[1]! };
}
