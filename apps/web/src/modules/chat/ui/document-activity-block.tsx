import { ArrowRight01Icon, File01Icon, Folder01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useDocumentPanel } from "~/modules/documents/ui/document-panel-context.ts";
import type { DocumentToolActivity } from "../client/use-message-stream.ts";
import { Button } from "~/ui/primitives/button";
import { cn } from "~/ui/utils";
import { disclosureTriggerClassName } from "~/ui/disclosure-classes.ts";
import { focusRingClassName } from "~/ui/focus-ring.ts";
import { ActivityFace } from "./activity-face.tsx";
import {
  activityCardClassName,
  activityCardInteractiveClassName,
  activityRowClassName,
} from "./activity-row.ts";
import { type DocumentPart, isDocumentCard } from "./assistant-body.ts";
import { documentRunLabel, documentRunSucceeded } from "./document-activity-label.ts";

export function DocumentWidget({ documentId, title }: { documentId: string; title?: string }) {
  const { owned, gone, entry } = useDocumentPanel(documentId);
  const name = entry?.title ?? title ?? "Document";
  // A project document is shared with every member; say so where it appears.
  const kind = entry?.inProject ? "Project document" : "Document";
  const status = entry
    ? kind
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

/** One line for a run of reads and edits on a document, opening it when it is here. */
export function DocumentRunRow({ part }: { part: DocumentPart }) {
  const { entry } = useDocumentPanel(part.documentId ?? "");
  const running = part.activities.some((call) => call.status === "running");
  const face = (
    <ActivityFace
      icon={File01Icon}
      label={documentRunLabel(part.activities, part.named ?? false)}
      // The error was written for the model ("use a larger anchor"); the label says it in reader words.
      status={running ? "running" : documentRunSucceeded(part.activities) ? "done" : "failed"}
    />
  );
  // The row names a document that is open one click away, so it opens it rather
  // than making the person hunt for the card that created it.
  if (part.documentId && entry?.open)
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

/** A created document's card; any other call, alone, as a run of one. */
export function DocumentActivityBlock({ activity }: { activity: DocumentToolActivity }) {
  const reference = activity.result?.documentId;
  if (reference && isDocumentCard(activity))
    return (
      <DocumentWidget
        documentId={reference}
        {...(activity.result?.title ? { title: activity.result.title } : {})}
      />
    );
  return (
    <DocumentRunRow
      part={{
        kind: "document",
        key: activity.callId,
        ...(reference ? { documentId: reference } : {}),
        activities: [activity],
        named: true,
      }}
    />
  );
}
