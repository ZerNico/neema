/** Measure the virtual result, including surrogate pairs formed or split at edit boundaries. */
export const literalReplacementSize = (
  text: string,
  before: string,
  after: string,
  all: boolean,
) => {
  let bytes = 0;
  let replacements = 0;
  let previousHigh = false;
  const appendSize = (part: string, size = Buffer.byteLength(part, "utf8")) => {
    if (part.length === 0) return;
    const first = part.charCodeAt(0);
    bytes += size - (previousHigh && first >= 0xdc00 && first <= 0xdfff ? 2 : 0);
    const last = part.charCodeAt(part.length - 1);
    previousHigh = last >= 0xd800 && last <= 0xdbff;
  };
  const afterBytes = Buffer.byteLength(after, "utf8");
  let cursor = 0;
  if (before !== "") {
    for (let index = text.indexOf(before); index !== -1; index = text.indexOf(before, cursor)) {
      appendSize(text.slice(cursor, index));
      appendSize(after, afterBytes);
      replacements += 1;
      cursor = index + before.length;
      if (!all) break;
    }
  }
  appendSize(text.slice(cursor));
  return { bytes, replacements };
};
