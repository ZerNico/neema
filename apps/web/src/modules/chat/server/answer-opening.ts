import type { Prompt } from "effect/ai";

/**
 * What an answer's first request carried after its user message: the
 * application data it started with and its first reminder. History replays it
 * in place, so the next turn's request extends that one exactly and a provider
 * that caches at the end of a request reads everything up to it.
 * See docs/internals/prompt-caching.md.
 */
export interface AnswerOpening {
  readonly v: 1;
  readonly blocks: ReadonlyArray<OpeningBlock>;
}

export interface OpeningBlock {
  readonly message: Prompt.MessageEncoded;
  /** What the block shows that access can be taken from; see `needsOf`. */
  readonly needs?: OpeningNeeds;
  /** Earlier turns' sources a reminder listed, so a later one need not while this block is replayed. */
  readonly sources?: ReadonlyArray<number>;
  /** Blocks this one said no longer apply, so a later opening does not say it again. */
  readonly gone?: ReadonlyArray<string>;
  /** Part of the first reminder, not application data: never compared as a data block. */
  readonly reminder?: true;
}

export interface OpeningNeeds {
  readonly documents?: ReadonlyArray<string>;
  readonly knowledge?: ReadonlyArray<string>;
  readonly skills?: ReadonlyArray<string>;
  /** Instructions, replayed only at the revision that is still current: `id@revision`. */
  readonly skillRevisions?: ReadonlyArray<string>;
  readonly working?: ReadonlyArray<string>;
  /** What rendered the block at all: a permission, the chat's project, the image model. */
  readonly features?: ReadonlyArray<string>;
}

/** What the current attempt may show; a replayed block needing anything else is left out. */
export interface OpeningAccess {
  readonly documents: ReadonlySet<string>;
  readonly knowledge: ReadonlySet<string>;
  readonly skills: ReadonlySet<string>;
  readonly skillRevisions: ReadonlySet<string>;
  /** Kept drafts, offered only while the editor that made them is. */
  readonly working: ReadonlySet<string>;
  readonly features: ReadonlySet<string>;
}

export const messageText = (message: Prompt.MessageEncoded) =>
  typeof message.content === "string"
    ? message.content
    : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

const ids = (text: string, pattern: RegExp) => [
  ...new Set([...text.matchAll(pattern)].map((match) => match[1]!)),
];

export type MarkerKind = "documents" | "knowledge" | "skills" | "working";
const ALL_MARKERS: ReadonlyArray<MarkerKind> = ["documents", "knowledge", "skills", "working"];

/**
 * The documents, knowledge documents, skills and kept drafts a block shows, by
 * the markers their renderers write: a document view's `<document … id="…">`,
 * knowledge evidence's `"documentId"`, the skill catalogue's `"skillId"` and a
 * pinned skill's revision, a draft's `working:<id>@`. Only the kinds the
 * block's source writes are read, so a document quoting one of them is not
 * held to it; a stray match there would cost a cache miss every turn.
 */
export const needsOf = (
  message: Prompt.MessageEncoded,
  kinds: ReadonlyArray<MarkerKind> = ALL_MARKERS,
): OpeningNeeds | undefined => {
  const text = messageText(message);
  const reads = (kind: MarkerKind) => kinds.includes(kind);
  const documents = reads("documents") ? ids(text, /<document\b[^>]*?\sid="([^"]+)"/g) : [];
  const knowledge = reads("knowledge") ? ids(text, /"documentId":"([^"]+)"/g) : [];
  const skills = reads("skills") ? ids(text, /"skillId":"([^"]+)"/g) : [];
  const skillRevisions = reads("skills")
    ? [...text.matchAll(/<skill-guidance id="([^"]+)" revision="([^"]+)">/g)].map(
        (match) => `${match[1]}@${match[2]}`,
      )
    : [];
  // Guidance without a revision cannot show it is current, so it is never replayed.
  if (reads("skills") && /<skill-guidance\b(?![^>]*\srevision=)/.test(text))
    skillRevisions.push("unpinned");
  const working = reads("working") ? ids(text, /\bworking:([\w-]+)@/g) : [];
  if (
    !documents.length &&
    !knowledge.length &&
    !skills.length &&
    !skillRevisions.length &&
    !working.length
  )
    return undefined;
  return {
    ...(documents.length ? { documents } : {}),
    ...(knowledge.length ? { knowledge } : {}),
    ...(skills.length ? { skills } : {}),
    ...(skillRevisions.length ? { skillRevisions } : {}),
    ...(working.length ? { working } : {}),
  };
};

const allowed = (block: OpeningBlock, access: OpeningAccess) =>
  (block.needs?.documents ?? []).every((id) => access.documents.has(id)) &&
  (block.needs?.knowledge ?? []).every((id) => access.knowledge.has(id)) &&
  (block.needs?.skills ?? []).every((id) => access.skills.has(id)) &&
  (block.needs?.skillRevisions ?? []).every((id) => access.skillRevisions.has(id)) &&
  (block.needs?.working ?? []).every((id) => access.working.has(id)) &&
  (block.needs?.features ?? []).every((id) => access.features.has(id));

/**
 * An earlier answer's opening as this attempt may replay it. Access is checked
 * now, as for everything else an attempt shows: a block whose document,
 * collection or skill is gone or no longer shared is left out, which costs one
 * cache miss and only when access changed.
 */
export const replayedBlocks = (opening: AnswerOpening | null | undefined, access: OpeningAccess) =>
  (opening?.blocks ?? []).filter((block) => allowed(block, access));

export const replayedOpening = (opening: AnswerOpening | null | undefined, access: OpeningAccess) =>
  replayedBlocks(opening, access).map((block) => block.message);

/**
 * A block's identity across openings: its first line, or its first two when the
 * first is a bare tag (`<application-policy>`), which many blocks share.
 */
export const blockName = (message: Prompt.MessageEncoded) => {
  const lines = messageText(message)
    .split("\n")
    .filter((line) => line.trim());
  const first = lines[0] ?? "";
  return (/^<[\w-]+>$/.test(first.trim()) ? `${first}\n${lines[1] ?? ""}` : first).slice(0, 200);
};

export const blockKey = (message: Prompt.MessageEncoded) => JSON.stringify(message.content);

/** The source indexes a replayed tool result names, which need no recap while it is in history. */
export const resultSources = (result: unknown): number[] => {
  const listed =
    result && typeof result === "object" && "sources" in result ? result.sources : undefined;
  return Array.isArray(listed)
    ? listed.flatMap((source: unknown) =>
        source &&
        typeof source === "object" &&
        "index" in source &&
        typeof source.index === "number"
          ? [source.index]
          : [],
      )
    : [];
};
