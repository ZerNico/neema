import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff";

const MAX_INPUT_CHARS = 2_000_000;
const PREVIEW_CHARS = 2_000;

/** A bounded transcript preview, not a patch the caller should apply. */
export const unifiedDiff = (path: string, before: string, after: string) => {
  if (before.length + after.length <= MAX_INPUT_CHARS) {
    const patch = createTwoFilesPatch(
      `a/${path}`,
      `b/${path}`,
      before,
      after,
      undefined,
      undefined,
      {
        context: 3,
        maxEditLength: 2_000,
        timeout: 50,
        headerOptions: FILE_HEADERS_ONLY,
      },
    );
    if (patch !== undefined) return { diff: patch, truncated: false };
  }

  // Skip the common prefix so a large-file preview still shows the actual edit.
  let start = 0;
  const length = Math.min(before.length, after.length);
  while (start < length && before[start] === after[start]) start += 1;
  start = Math.max(0, start - 120);
  const preview = (text: string, prefix: string) =>
    text
      .slice(start, start + PREVIEW_CHARS)
      .split("\n")
      .map((line) => `${prefix}${line}`)
      .join("\n");
  const diff = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `Full diff omitted: computation limit reached. Excerpts from character ${start + 1} (${before.length} -> ${after.length} characters).`,
    preview(before, "-"),
    preview(after, "+"),
    "[Preview only; remaining content omitted.]",
  ].join("\n");
  return { diff, truncated: true };
};
