import { Alert02Icon, Cancel01Icon, File01Icon, Pdf01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useState } from "react";
import type { AttachmentKind } from "../constants.ts";
import { formatFileSize } from "../constants.ts";
import { AttachmentPreviewDialog } from "./attachment-preview.tsx";
import { Button } from "~/ui/primitives/button";
import { Spinner } from "~/ui/primitives/spinner";
import { cn } from "~/ui/utils";
import { focusRingClassName } from "~/ui/focus-ring.ts";

/** The subset of an upload / stored attachment a chip renders. */
export interface AttachmentChipItem {
  readonly fileName: string;
  readonly size: number;
  readonly kind: AttachmentKind;
  readonly status?: "uploading" | "complete" | "error";
  readonly previewUrl?: string | null;
  readonly error?: string | null;
}

const KIND_ICON = { pdf: Pdf01Icon, text: File01Icon, image: File01Icon } as const;

/**
 * Shared by the composer (removable, live upload state) and sent messages
 * (read-only, linking to the authenticated bytes route).
 */
export function AttachmentChip({
  item,
  warning,
  onRemove,
  href,
  preview,
  className,
}: {
  item: AttachmentChipItem;
  /** Set when the selected model cannot read this file; blocks submit. */
  warning?: string | null;
  onRemove?: (() => void) | undefined;
  href?: string | undefined;
  /** Full-content URL; when set, clicking the chip opens an in-app preview. */
  preview?: string | null | undefined;
  className?: string;
}) {
  const status = item.status ?? "complete";
  const uploading = status === "uploading";
  const problem = status === "error" ? (item.error ?? "Upload failed.") : (warning ?? null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const body = (
    <>
      <span className="bg-muted text-muted-foreground relative grid size-9 shrink-0 place-items-center overflow-hidden rounded-xl">
        {item.previewUrl ? (
          <img src={item.previewUrl} alt="" className="size-full object-cover" />
        ) : (
          <HugeiconsIcon icon={KIND_ICON[item.kind]} strokeWidth={2} className="size-4" />
        )}
        {uploading ? (
          <span className="bg-background/70 absolute inset-0 grid place-items-center">
            <Spinner aria-hidden />
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0 flex-col text-left">
        <span className="truncate text-xs font-medium">{item.fileName}</span>
        <span
          className={cn(
            "text-2xs truncate",
            status === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {problem ?? (uploading ? "Uploading…" : formatFileSize(item.size))}
        </span>
      </span>
      {problem ? (
        <HugeiconsIcon
          icon={Alert02Icon}
          strokeWidth={2}
          className={cn(
            "size-3.5 shrink-0",
            status === "error" ? "text-destructive" : "text-warning",
          )}
        />
      ) : null}
    </>
  );

  const dialog = preview ? (
    <AttachmentPreviewDialog
      target={{ fileName: item.fileName, size: item.size, kind: item.kind, url: preview }}
      open={previewOpen}
      onOpenChange={setPreviewOpen}
    />
  ) : null;

  // The subtitle truncates, so the full reason lives on `title` too.
  const shell = cn(
    "border-border bg-background flex max-w-56 items-center gap-2 rounded-2xl border p-1.5 pr-2 shadow-sm",
    status === "error" ? "border-destructive/50" : "",
    warning && status !== "error" ? "border-warning/60" : "",
    className,
  );

  if (href) {
    return (
      <>
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          title={problem ?? item.fileName}
          className={cn(
            shell,
            focusRingClassName,
            "hover:bg-accent transition-colors",
          )}
          // Plain click previews in place; modified clicks keep the browser's
          // open-in-new-tab behavior for the raw file.
          onClick={
            preview
              ? (event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault();
                  setPreviewOpen(true);
                }
              : undefined
          }
        >
          {body}
        </a>
        {dialog}
      </>
    );
  }

  return (
    <>
      <div className={shell} title={problem ?? item.fileName} aria-busy={uploading || undefined}>
        {/* Always the same wrapper, since swapping it in only once a preview URL
            exists would recreate the chip's DOM mid-upload. */}
        <button
          type="button"
          aria-label={`Preview ${item.fileName}`}
          onClick={preview ? () => setPreviewOpen(true) : undefined}
          disabled={!preview}
          className={cn(
            focusRingClassName,
            "flex min-w-0 items-center gap-2 rounded-xl",
            preview ? "cursor-pointer" : "cursor-default",
          )}
        >
          {body}
        </button>
        {onRemove ? (
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Remove ${item.fileName}`}
            onClick={onRemove}
            className="text-muted-foreground hover:text-foreground -mr-1 size-5 shrink-0"
          >
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-3.5" />
          </Button>
        ) : null}
      </div>
      {dialog}
    </>
  );
}

/** Wrapper the composer and the sent-message bubble share. */
export function AttachmentChipRow({
  children,
  className,
  "aria-label": ariaLabel,
}: {
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)} aria-label={ariaLabel}>
      {children}
    </div>
  );
}
