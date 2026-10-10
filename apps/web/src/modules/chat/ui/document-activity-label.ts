import type { DocumentToolActivity } from "../client/use-message-stream.ts";

/** A call in reader words; without a title, it says "the document". */
export function documentActivityLabel(
  activity: DocumentToolActivity,
  title: string | null = activity.result?.title ?? null,
) {
  if (activity.status === "running") {
    if (activity.name === "create_document") return "Creating a document";
    if (activity.name === "edit_document") return "Editing the document";
    if (activity.name === "comment_on_document") return "Commenting";
    return "Reading documents";
  }
  switch (activity.result?.outcome) {
    case "created":
      return title ? `Created ${title}` : "Created a document";
    case "updated":
      return title ? `Edited ${title}` : "Edited the document";
    case "unchanged":
      return title ? `${title} unchanged` : "Document unchanged";
    case "read":
      return title ? `Read ${title}` : "Read the document";
    case "listed":
      return "Checked documents";
    case "commented":
      return title ? `Commented on ${title}` : "Commented on the document";
    default:
      return "Couldn’t update the document";
  }
}

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
export function documentRunLabel(calls: ReadonlyArray<DocumentToolActivity>, named = true) {
  const title = named ? calls.find((call) => call.result?.title)?.result?.title : undefined;
  const running = calls.find((call) => call.status === "running");
  if (running?.name === "edit_document") return title ? `Editing ${title}` : "Editing the document";
  if (running?.name === "read_chat_document")
    return title ? `Reading ${title}` : "Reading the document";
  if (running) return documentActivityLabel(running, null);
  const best = calls.reduce((most, call) => (weight(call) > weight(most) ? call : most));
  return documentActivityLabel(best, named ? (best.result?.title ?? title ?? null) : null);
}
