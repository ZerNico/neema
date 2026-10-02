import { ArrowRight01Icon, File01Icon, Folder01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useDocumentPanel } from "~/modules/documents/ui/document-owner.tsx";
import type { DocumentToolActivity } from "../client/use-message-stream.ts";
import { Button } from "~/ui/primitives/button";
import { cn } from "~/ui/utils";
import { disclosureTriggerClassName } from "~/ui/disclosure.tsx";
import { focusRingClassName } from "~/ui/focus-ring.ts";
import { ActivityFace } from "./activity-face.tsx";
import {
  activityCardClassName,
  activityCardInteractiveClassName,
  activityRowClassName,
} from "./activity-row.ts";

export function documentActivityLabel(activity: DocumentToolActivity) {
  const title = activity.result?.title;
  if (activity.status === "running") {
    if (activity.name === "create_document") return "Creating a document";
    if (activity.name === "edit_document" || activity.name === "replace_document")
      return "Updating the document";
    return "Reading documents";
  }
  switch (activity.result?.outcome) {
    case "created":
      return title ? `Created ${title}` : "Created a document";
    case "updated":
      return title ? `Updated ${title}` : "Updated a document";
    case "unchanged":
      return title ? `${title} unchanged` : "Document unchanged";
    case "read":
      return title ? `Read ${title}` : "Read a document";
    case "listed":
      return "Checked documents";
    default:
      return "Couldn’t update the document";
  }
}

export function DocumentWidget({ documentId, title }: { documentId: string; title?: string }) {
  const { owned, gone, entry } = useDocumentPanel(documentId);
  const name = entry?.title ?? title ?? "Document";
  // A project document is shared with every member; say so where it appears.
  const kind = entry?.inProject ? "Project document" : "Document";
  const status = entry
    ? entry.tasks
      ? `${kind} · ${entry.tasks.done} of ${entry.tasks.total} tasks done`
      : kind
    : gone
      ? "Document deleted"
      : owned
        ? "Loading document…"
        : "From another chat";
  const contents = (
    <>
      <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-xl">
        <HugeiconsIcon
          icon={entry?.inProject ? Folder01Icon : File01Icon}
          strokeWidth={2}
          className="text-muted-foreground size-4"
          aria-hidden
        />
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-sm font-medium">{name}</span>
        <span className="text-muted-foreground block truncate text-xs">{status}</span>
      </span>
      {entry?.open ? (
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          strokeWidth={2}
          className="text-muted-foreground size-4 shrink-0"
          aria-hidden
        />
      ) : null}
    </>
  );
  if (entry?.open)
    return (
      <button
        type="button"
        className={cn(activityCardClassName, activityCardInteractiveClassName)}
        aria-label={`Open document: ${name}`}
        aria-expanded={entry.expanded}
        onClick={entry.open}
      >
        {contents}
      </button>
    );
  return (
    <div className={activityCardClassName}>
      {contents}
      {entry?.retry ? (
        <Button size="sm" variant="ghost" onClick={entry.retry}>
          Retry loading document
        </Button>
      ) : null}
    </div>
  );
}

/** One line for a call that touched a document the full card already shows. */
function DocumentActivityRow({
  activity,
  documentId,
}: {
  activity: DocumentToolActivity;
  documentId: string | undefined;
}) {
  const { entry } = useDocumentPanel(documentId ?? "");
  const failed = activity.status === "error" || !activity.result?.outcome;
  const face = (
    <ActivityFace
      icon={File01Icon}
      label={documentActivityLabel(activity)}
      // The error was written for the model ("use a larger anchor"); the label says it in reader words.
      status={activity.status === "running" ? "running" : failed ? "failed" : "done"}
    />
  );
  // The row names a document that is open one click away, so it opens it rather
  // than making the person hunt for the card that created it.
  if (documentId && entry?.open)
    return (
      <button
        type="button"
        onClick={entry.open}
        aria-expanded={entry.expanded}
        className={cn(disclosureTriggerClassName, focusRingClassName, "mb-2 rounded-lg")}
      >
        {face}
      </button>
    );
  return <div className={cn(activityRowClassName, "mb-2")}>{face}</div>;
}

export function DocumentActivityBlock({ activity }: { activity: DocumentToolActivity }) {
  const reference = activity.result?.documentId;
  const create = activity.name === "create_document" && activity.result?.outcome === "created";
  if (reference && create)
    return (
      <DocumentWidget
        documentId={reference}
        {...(activity.result?.title ? { title: activity.result.title } : {})}
      />
    );
  return <DocumentActivityRow activity={activity} documentId={reference} />;
}
