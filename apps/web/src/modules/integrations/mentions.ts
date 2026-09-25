import { INTEGRATIONS } from "./catalog.ts";

/** `start` is the segment's offset in the text: unique, so it doubles as a key. */
export type MentionSegment =
  | { kind: "text"; start: number; text: string }
  | { kind: "mention"; start: number; text: string; integrationId: string };

const escape = (value: string) => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

/** The shipped integrations' names as one regex alternation, for building matchers. */
export const integrationNamePattern = INTEGRATIONS.map((integration) =>
  escape(integration.name),
).join("|");

/** The integration a mention's name (without "@") refers to, ignoring case. */
export const integrationForName = (name: string) =>
  INTEGRATIONS.find((integration) => integration.name.toLowerCase() === name.toLowerCase()) ?? null;

// Only the shipped integrations' names count, at the start of a word and
// ending at a word boundary, so an email address or `@Outlines` stays text.
const pattern = new RegExp(
  String.raw`(^|\s)(@(${integrationNamePattern}))(?![\p{L}\p{N}_-])`,
  "giu",
);

/**
 * Splits message text into plain runs and `@Name` integration mentions, for
 * drawing them as tags. The text itself is unchanged: the model reads the
 * same words, and joining the segments gives the input back.
 */
export function splitIntegrationMentions(text: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index + match[1]!.length;
    const integration = integrationForName(match[3]!);
    if (!integration) continue;
    if (start > last) segments.push({ kind: "text", start: last, text: text.slice(last, start) });
    segments.push({ kind: "mention", start, text: match[2]!, integrationId: integration.id });
    last = start + match[2]!.length;
  }
  if (last < text.length) segments.push({ kind: "text", start: last, text: text.slice(last) });
  return segments;
}
