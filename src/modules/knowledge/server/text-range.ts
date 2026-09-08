/** Clamp a UTF-16 end offset without splitting a supplementary character. */
export const textEnd = (text: string, end: number): number => {
  const bounded = Math.max(0, Math.min(text.length, end));
  const before = text.charCodeAt(bounded - 1);
  const after = text.charCodeAt(bounded);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
    ? bounded - 1
    : bounded;
};

export const textPrefix = (text: string, length: number): string =>
  text.slice(0, textEnd(text, length));
