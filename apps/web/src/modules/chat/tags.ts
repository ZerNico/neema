import { splitIntegrationMentions, type Mentionable } from "~/modules/integrations/mentions.ts";

/**
 * A skill or collection picked into a message. Like an agent reference
 * (`references.ts`) it stays in the stored text as a Markdown link to its page,
 * `[/review](/skills/<id>)` or `[#Contracts](/knowledge/<id>)`, so the model reads
 * which one is meant and where; people see a tag. The message's own selection
 * (skill ids, collection ids) is still what loads them; the link only names them.
 */
export interface ContextTag {
  kind: "skill" | "collection";
  id: string;
  /** The name without its "/" or "#". */
  name: string;
}

const PREFIX = { skill: "/", collection: "#" } as const;
const PATH = { skill: "skills", collection: "knowledge" } as const;

// The prefix must match the page: "/" goes with /skills, "#" with /knowledge.
const TAG =
  /\[(?:\/([^\]\n]{1,80})\]\(\/skills|#([^\]\n]{1,80})\]\(\/knowledge)\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\)/gu;

/** A name as link text: brackets and line breaks would end the link early. */
const linkText = (name: string) =>
  name
    .replaceAll(/[[\]\n]/gu, " ")
    .trim()
    .slice(0, 80);

export const tagMarkup = (tag: ContextTag) =>
  `[${PREFIX[tag.kind]}${linkText(tag.name)}](/${PATH[tag.kind]}/${tag.id})`;

/** The text with each tag's link replaced by its words, for copying and short labels. */
export const tagWords = (text: string) =>
  text.replace(TAG, (_, skill?: string, collection?: string) =>
    skill === undefined ? `#${collection}` : `/${skill}`,
  );

/** Every skill and collection tag in the text, in order, repeats included. */
export function findTags(text: string): ContextTag[] {
  return [...text.matchAll(TAG)].map((match) =>
    match[1] === undefined
      ? { kind: "collection", id: match[3]!, name: match[2]! }
      : { kind: "skill", id: match[3]!, name: match[1] },
  );
}

export type MessageSegment =
  | { kind: "text"; start: number; text: string }
  | { kind: "integration"; start: number; text: string; integrationId: string }
  | { kind: "tag"; start: number; text: string; tag: ContextTag };

/**
 * Message text split into plain runs and everything drawn as a tag: skill and
 * collection links and `@Integration` mentions. `start` is each segment's
 * offset, unique, so it doubles as a key; joining the texts gives the input back.
 */
export function splitMessageTags(text: string, integrations: Mentionable): MessageSegment[] {
  const segments: MessageSegment[] = [];
  const plain = (from: number, to: number) => {
    if (to <= from) return;
    for (const segment of splitIntegrationMentions(text.slice(from, to), integrations))
      segments.push(
        segment.kind === "mention"
          ? {
              kind: "integration",
              start: from + segment.start,
              text: segment.text,
              integrationId: segment.integrationId,
            }
          : { kind: "text", start: from + segment.start, text: segment.text },
      );
  };
  let last = 0;
  for (const match of text.matchAll(TAG)) {
    plain(last, match.index);
    const tag: ContextTag =
      match[1] === undefined
        ? { kind: "collection", id: match[3]!, name: match[2]! }
        : { kind: "skill", id: match[3]!, name: match[1] };
    segments.push({ kind: "tag", start: match.index, text: match[0], tag });
    last = match.index + match[0].length;
  }
  plain(last, text.length);
  return segments;
}
