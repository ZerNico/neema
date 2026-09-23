/**
 * An agent or schedule a message is about. The model finds it through a
 * Markdown link to its page (`[this schedule](/schedules/<id>)`), so the link
 * stays in the stored text; people see a chip instead, in the composer and in
 * the sent message, and the sentence reads with the link's own words.
 */
export interface MessageReference {
  kind: "agent" | "schedule";
  id: string;
  /** The link's words, which stand in for it in the readable text. */
  label: string;
}

const REFERENCE =
  /\[([^\]\n]{1,80})\]\(\/(agents|schedules)\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\)/gu;

const linkOf = (reference: MessageReference) =>
  `[${reference.label}](/${reference.kind === "agent" ? "agents" : "schedules"}/${reference.id})`;

/** The text with each reference link replaced by its words, and the references found. */
export function extractReferences(content: string): {
  text: string;
  references: MessageReference[];
} {
  const references: MessageReference[] = [];
  const text = content.replace(REFERENCE, (_, label: string, path: string, id: string) => {
    const kind = path === "agents" ? "agent" : "schedule";
    if (!references.some((known) => known.kind === kind && known.id === id))
      references.push({ kind, id, label });
    return label;
  });
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
