import { m } from "~/paraglide/messages.js";
import type { DocumentToolActivity } from "../client/use-message-stream.ts";

/**
 * A step in the words it takes inside a summary ("edited the document") and
 * at its start ("Edited the document"). The messages hold the inner form, so
 * German nouns keep their capitals; a leading name is never recased.
 */
export interface Clause {
  readonly inline: string;
  readonly lead: string;
}

const upperFirst = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export const clause = (inline: string, ...names: ReadonlyArray<string>): Clause => ({
  inline,
  lead: names.some((name) => name && inline.startsWith(name)) ? inline : upperFirst(inline),
});

/** A call in reader words; without a title, it says "the document". */
export function documentActivityClause(
  activity: DocumentToolActivity,
  title: string | null = activity.result?.title ?? null,
): Clause {
  const named = (
    withTitle: (inputs: { title: string }) => string,
    without: () => string,
  ): Clause => (title ? clause(withTitle({ title }), title) : clause(without()));
  if (activity.status === "running") {
    if (activity.name === "create_document") return clause(m.chat_document_creating());
    if (activity.name === "edit_document") return clause(m.chat_document_editing());
    if (activity.name === "comment_on_document") return clause(m.chat_document_commenting());
    return clause(m.chat_document_reading_all());
  }
  switch (activity.result?.outcome) {
    case "created":
      return named(m.chat_document_created_named, m.chat_document_created);
    case "updated":
      return named(m.chat_document_edited_named, m.chat_document_edited);
    case "unchanged":
      return named(m.chat_document_unchanged_named, m.chat_document_unchanged);
    case "read":
      return named(m.chat_document_read_named, m.chat_document_read);
    case "listed":
      return clause(m.chat_document_checked());
    case "commented":
      return named(m.chat_document_commented_named, m.chat_document_commented);
    default:
      return clause(m.chat_document_failed());
  }
}

export const documentActivityLabel = (
  activity: DocumentToolActivity,
  title?: string | null,
): string => documentActivityClause(activity, title).lead;

/** How much a call did, so a run is named after its weightiest one; failures rank last. */
const WEIGHT: Partial<Record<string, number>> = {
  created: 6,
  updated: 5,
  commented: 4,
  unchanged: 3,
  read: 2,
  listed: 1,
};
const weight = (call: DocumentToolActivity) => WEIGHT[call.result?.outcome ?? ""] ?? 0;

/** Whether any call in a run did what it set out to do. */
export const documentRunSucceeded = (calls: ReadonlyArray<DocumentToolActivity>) =>
  calls.some((call) => call.status !== "running" && weight(call) > 0);

/**
 * One label for a run of calls on a document: what is running now, else the
 * most it did. A retried edit is not news, so a failure names the run only
 * when nothing in it succeeded. The title is named only where the answer
 * touched more than one document; the card already names a lone one.
 */
export function documentRunClause(
  calls: ReadonlyArray<DocumentToolActivity>,
  named = true,
): Clause {
  const title = named ? calls.find((call) => call.result?.title)?.result?.title : undefined;
  const running = calls.find((call) => call.status === "running");
  if (running?.name === "edit_document")
    return title
      ? clause(m.chat_document_editing_named({ title }), title)
      : clause(m.chat_document_editing());
  if (running?.name === "read_chat_document")
    return title
      ? clause(m.chat_document_reading_named({ title }), title)
      : clause(m.chat_document_reading());
  if (running) return documentActivityClause(running, null);
  const best = calls.reduce((most, call) => (weight(call) > weight(most) ? call : most));
  return documentActivityClause(best, named ? (best.result?.title ?? title ?? null) : null);
}

export const documentRunLabel = (
  calls: ReadonlyArray<DocumentToolActivity>,
  named?: boolean,
): string => documentRunClause(calls, named).lead;
