import { ArrowRight01Icon, File01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useDocumentPanel } from "~/modules/documents/ui/document-owner.tsx";
import type { DocumentToolActivity } from "../client/use-message-stream.ts";
import { Button } from "~/ui/primitives/button";
import { cn } from "~/ui/utils";
import { activityRowClassName } from "./activity-row.ts";

export function documentActivityLabel(activity: DocumentToolActivity) {
  const title = activity.result?.title;
  if (activity.status === "running") {
    if (activity.name === "create_document") return "Creating document…";
    if (activity.name === "edit_document" || activity.name === "replace_document")
      return "Updating document…";
    return "Reading documents…";
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
      return "Document not updated";
  }
}

export function DocumentWidget({ documentId, title }: { documentId: string; title?: string }) {
  const { owned, gone, entry } = useDocumentPanel(documentId);
  const name = entry?.title ?? title ?? "Document";
  const status = entry
    ? entry.tasks
      ? `Markdown · ${entry.tasks.done} of ${entry.tasks.total} tasks done`
      : "Markdown"
    : gone
      ? "Document deleted"
      : owned
        ? "Loading document…"
        : "From another chat";
  const contents = (
    <>
      <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-xl">
        <HugeiconsIcon icon={File01Icon} strokeWidth={2} className="text-muted-foreground size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-sm font-medium">{name}</span>
        <span className="text-muted-foreground block truncate text-xs">{status}</span>
      </span>
      {entry?.open ? (
        <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className="text-muted-foreground shrink-0" aria-hidden />
      ) : null}
    </>
  );
  const className = "mb-3 flex h-auto w-full max-w-sm items-center gap-3 rounded-2xl border px-3 py-3";
  if (entry?.open)
    return (
      <Button
        variant="outline"
        className={className}
        aria-label={`Open document: ${name}`}
        aria-expanded={entry.expanded}
        onClick={entry.open}
      >
        {contents}
      </Button>
    );
  return (
    <div className={className}>
      {contents}
      {entry?.retry ? (
        <Button size="sm" variant="ghost" onClick={entry.retry}>
          Retry loading document
        </Button>
      ) : null}
    </div>
  );
}

export function DocumentActivityBlock({ activity }: { activity: DocumentToolActivity }) {
  const reference = activity.result?.documentId;
  const create = activity.name === "create_document" && activity.result?.outcome === "created";
  if (reference && create)
    return <DocumentWidget documentId={reference} {...(activity.result?.title ? { title: activity.result.title } : {})} />;
  return (
    <div className={cn(activityRowClassName, "mb-2")}>
      <HugeiconsIcon icon={File01Icon} strokeWidth={2} className="size-4" aria-hidden />
      <span className={cn(activity.status === "running" && "text-shimmer")}>
        {documentActivityLabel(activity)}
        {activity.status === "error" && (activity.error || activity.result?.message)
          ? `: ${activity.error ?? activity.result?.message}`
          : null}
      </span>
    </div>
  );
}
