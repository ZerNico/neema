// Citation markers (`[^N]`) are rendering syntax, not content. Shared between
// the UI (display/copy) and the stream engine (history hygiene) — hence module
// root, not ui/.

/** Removes every citation marker. For clipboard text and model history. */
export function stripCitationMarkers(content: string): string {
  return content.replace(/\[\^\d+\]/g, "");
}

/**
 * Removes markers that have no `[^N]: …` definition in the content, plus a
 * half-streamed trailing `[^1`.
 *
 * For messages rendered without a source list: a model that ran no search can
 * still emit markers (it imitates cited turns earlier in the conversation),
 * and GFM would leave those as literal `[^1]` text. Markers the model backed
 * with its own definitions are real footnotes and stay.
 */
export function stripUndefinedCitationMarkers(content: string): string {
  const defined = new Set([...content.matchAll(/^\[\^(\d+)\]:/gm)].map((m) => m[1]));
  return content
    .replace(/\[\^\d*$/, "")
    .replace(/\[\^(\d+)\]/g, (match, n: string) => (defined.has(n) ? match : ""));
}
