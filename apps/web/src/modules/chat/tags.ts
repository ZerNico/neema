import { splitIntegrationMentions, type Mentionable } from "~/modules/integrations/mentions.ts";

/**
 * A skill or collection picked into a message. Like an agent reference
 * (`references.ts`) it stays in the stored text as a Markdown link to its page,
 * `[/review](/skills/<id>)` or `[#Contracts](/knowledge/<id>)`, so the model reads
 * which one is meant and where; people see a tag. The message's own selection
 * (skill ids, collection ids) is still what loads them; the link only names them.
 */
export interface ContextTag {
  /** `image` names a chat image by its file link, so the model can pass it to edit. */
  kind: "skill" | "collection" | "image";
  id: string;
  /** The name without its "/" or "#". */
  name: string;
}

const PREFIX = { skill: "/", collection: "#", image: "" } as const;
const PATH = { skill: "skills", collection: "knowledge", image: "api/files" } as const;

// The prefix must match the page: "/" goes with /skills, "#" with /knowledge,
// and an image is any name linking to its file.
const TAG =
  /\[(?:\/(?<skill>[^\]\n]{1,80})\]\(\/skills|#(?<collection>[^\]\n]{1,80})\]\(\/knowledge|(?<image>[^\]\n/#][^\]\n]{0,79})\]\(\/api\/files)\/(?<id>[A-Za-z0-9][A-Za-z0-9_-]{0,127})\)/gu;

const tagOf = (match: RegExpMatchArray): ContextTag => {
  const groups = match.groups!;
  if (groups["skill"] !== undefined)
    return { kind: "skill", id: groups["id"]!, name: groups["skill"] };
  if (groups["collection"] !== undefined)
    return { kind: "collection", id: groups["id"]!, name: groups["collection"] };
  return { kind: "image", id: groups["id"]!, name: groups["image"]! };
};

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
  text.replace(TAG, (...args: unknown[]) => {
    const groups = args.at(-1) as Record<string, string | undefined>;
    return groups["skill"] !== undefined
      ? `/${groups["skill"]}`
      : groups["collection"] !== undefined
        ? `#${groups["collection"]}`
        : groups["image"]!;
  });

/** Every skill and collection tag in the text, in order, repeats included. */
export function findTags(text: string): ContextTag[] {
  return [...text.matchAll(TAG)].map(tagOf);
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
    const tag = tagOf(match);
    segments.push({ kind: "tag", start: match.index, text: match[0], tag });
    last = match.index + match[0].length;
  }
  plain(last, text.length);
  return segments;
}
