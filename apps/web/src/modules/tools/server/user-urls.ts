const URL_CANDIDATE = /https?:\/\/[^\s<>"'`]+/gi;
const SIMPLE_TRAILING_PUNCTUATION = /[.,!?;:]$/;
const CLOSING_PAIRS = [
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
] as const;

const occurrences = (value: string, needle: string): number =>
  [...value].filter((character) => character === needle).length;

/** Removes prose/Markdown punctuation without clipping balanced URL characters. */
const trimCandidate = (candidate: string): string => {
  let trimmed = candidate;
  while (SIMPLE_TRAILING_PUNCTUATION.test(trimmed)) trimmed = trimmed.slice(0, -1);

  let changed = true;
  while (changed) {
    changed = false;
    for (const [opening, closing] of CLOSING_PAIRS) {
      if (
        trimmed.endsWith(closing) &&
        occurrences(trimmed, closing) > occurrences(trimmed, opening)
      ) {
        trimmed = trimmed.slice(0, -1);
        changed = true;
      }
    }
  }
  return trimmed;
};

/** Canonical form used for the user-supplied URL allowlist. */
export const canonicalUserUrl = (raw: string): string | null => {
  try {
    const url = new URL(trimCandidate(raw.trim()));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
};

/** Finds explicit HTTP(S) links in user-authored text, in first-seen order. */
export const extractUserUrls = (texts: ReadonlyArray<string>): ReadonlyArray<string> => {
  const urls = new Set<string>();
  for (const text of texts) {
    for (const candidate of text.matchAll(URL_CANDIDATE)) {
      const canonical = canonicalUserUrl(candidate[0]);
      if (canonical) urls.add(canonical);
    }
  }
  return [...urls];
};

/** Builds reader authority from user-authored turns only, never assistant output. */
export const extractUserMessageUrls = (
  messages: ReadonlyArray<{ readonly role: string; readonly content: string }>,
): ReadonlyArray<string> =>
  extractUserUrls(
    messages.filter((message) => message.role === "user").map((message) => message.content),
  );
