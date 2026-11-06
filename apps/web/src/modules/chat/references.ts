/**
 * An agent, schedule or document a message is about. The model finds it
 * through a Markdown link to its page (`[this schedule](/schedules/<id>)`), so
 * the link stays in the stored text; people see a chip instead, in the
 * composer and in the sent message, and the sentence reads with the link's own
 * words. A named document is also added to the chat, see `linkReferencedDocuments`.
 */
export interface MessageReference {
  kind: "agent" | "schedule" | "document";
  id: string;
  /** The link's words, which stand in for it in the readable text. */
  label: string;
}

const REFERENCE =
  /\[([^\]\n]{1,80})\]\(\/(agents|schedules|documents)\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\)/gu;
const PATHS = { agent: "agents", schedule: "schedules", document: "documents" } as const;
const KINDS = { agents: "agent", schedules: "schedule", documents: "document" } as const;

/** Words a link can carry: no brackets or line breaks, at most what the pattern reads back. */
export const referenceLabel = (text: string) =>
  text
    .replaceAll(/[[\]\n]/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, 80) || "…";

const linkOf = (reference: MessageReference) =>
  `[${reference.label}](/${PATHS[reference.kind]}/${reference.id})`;

/** The text with each reference link replaced by its words, and the references found. */
export function extractReferences(content: string): {
  text: string;
  references: MessageReference[];
} {
  const references: MessageReference[] = [];
  const text = content.replace(
    REFERENCE,
    (_, label: string, path: keyof typeof KINDS, id: string) => {
      const kind = KINDS[path];
      if (!references.some((known) => known.kind === kind && known.id === id))
        references.push({ kind, id, label });
      return label;
    },
  );
  return { text, references };
}

/**
 * Puts the links back for sending: each reference replaces the first plain
 * occurrence of its words, or leads the message if those words were edited away.
 */
export function restoreReferences(text: string, references: readonly MessageReference[]) {
  let restored = text;
  for (const reference of references) {
    const index = restored.indexOf(reference.label);
    restored =
      index === -1
        ? `${linkOf(reference)} ${restored}`.trim()
        : restored.slice(0, index) +
          linkOf(reference) +
          restored.slice(index + reference.label.length);
  }
  return restored;
}
