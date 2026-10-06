/** `start` is the segment's offset in the text: unique, so it doubles as a key. */
export type MentionSegment =
  | { kind: "text"; start: number; text: string }
  | { kind: "mention"; start: number; text: string; integrationId: string };

/** What a mention can name: the integrations set up on this server, by their own names. */
export type Mentionable = ReadonlyArray<{ readonly id: string; readonly name: string }>;

const escape = (value: string) => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

/**
 * The names as one regex alternation, longest first so "Jira Ops" wins over
 * "Jira". Null when there is nothing to mention.
 */
export const mentionNamePattern = (integrations: Mentionable) =>
  integrations.length
    ? integrations
        .map((integration) => integration.name)
        .toSorted((a, b) => b.length - a.length)
        .map(escape)
        .join("|")
    : null;

/** The integration a mention's name (without "@") refers to, ignoring case. */
export const integrationForName = (name: string, integrations: Mentionable) =>
  integrations.find((integration) => integration.name.toLowerCase() === name.toLowerCase()) ?? null;

/**
 * Splits message text into plain runs and `@Name` integration mentions, for
 * drawing them as tags. Only these names count, at the start of a word and
 * ending at a word boundary, so an email address or `@Outlines` stays text.
 * The text itself is unchanged: joining the segments gives the input back.
 */
export function splitIntegrationMentions(
  text: string,
  integrations: Mentionable,
): MentionSegment[] {
  const names = mentionNamePattern(integrations);
  if (!names) return text ? [{ kind: "text", start: 0, text }] : [];
  const pattern = new RegExp(String.raw`(^|\s)(@(${names}))(?![\p{L}\p{N}_-])`, "giu");
  const segments: MentionSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index + match[1]!.length;
    const integration = integrationForName(match[3]!, integrations);
    if (!integration) continue;
    if (start > last) segments.push({ kind: "text", start: last, text: text.slice(last, start) });
    segments.push({ kind: "mention", start, text: match[2]!, integrationId: integration.id });
    last = start + match[2]!.length;
  }
  if (last < text.length) segments.push({ kind: "text", start: last, text: text.slice(last) });
  return segments;
}
