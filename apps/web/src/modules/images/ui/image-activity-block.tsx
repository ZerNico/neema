import { AiImageIcon, Download01Icon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { use, useState } from "react";
import type { AssistantFile } from "~/modules/chat/assistant-output.ts";
import { serverNow, type ImageToolActivity } from "~/modules/chat/client/use-message-stream.ts";
import { tagMarkup } from "~/modules/chat/tags.ts";
import { ActivityFace } from "~/modules/chat/ui/activity-face.tsx";
import { activityRowClassName } from "~/modules/chat/ui/activity-row.ts";
import { useElapsed } from "~/modules/chat/ui/use-elapsed.ts";
import { formatDuration } from "~/modules/chat/ui/work-steps.ts";
import { attachmentUrl } from "~/modules/attachments/client/use-attachment-uploads.ts";
import { AttachmentPreviewDialog } from "~/modules/attachments/ui/attachment-preview.tsx";
import { PreviewAction } from "~/modules/attachments/ui/preview-action.tsx";
import { GenuiActionsContext } from "~/modules/genui/ui/context.ts";
import { Button, buttonVariants } from "~/ui/primitives/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { cn } from "~/ui/utils";
import type { ImageQuality } from "@chat/model-client";
import { m } from "~/paraglide/messages.js";

const QUALITY_LABELS = {
  low: m.images_quality_low,
  medium: m.images_quality_medium,
  high: m.images_quality_high,
} satisfies Record<ImageQuality, () => string>;

/** "16:9" as the CSS ratio a placeholder holds while the image renders. */
const cssRatio = (ratio: string | undefined) => {
  const match = ratio ? /^(\d{1,2}):(\d{1,2})$/.exec(ratio) : null;
  return match ? `${match[1]} / ${match[2]}` : "1 / 1";
};

/**
 * One `generate_image` call: a placeholder in the shape asked for while the
 * model draws, then the images in its place. A refusal or failure reads as a
 * row with the provider's words, never as an empty frame.
 */
export function ImageActivityBlock({
  activity,
  files,
  preview,
}: {
  activity: ImageToolActivity;
  files: ReadonlyArray<AssistantFile>;
  /** The newest in-progress image, as a data URI, when the model streams them. */
  preview?: string | undefined;
}) {
  const running = activity.status === "running";
  // Mounted mid-call (a reload) without a start time counts from now.
  const [mountedAt] = useState(serverNow);
  const elapsed = useElapsed(activity.startedAt ?? mountedAt, running);
  // Never fewer than one: a call that asked for none still draws one.
  const count = Math.max(1, activity.requested);
  const drawing = (activity.editing ? m.images_activity_editing : m.images_activity_creating)({
    count,
  });

  if (running)
    return (
      <div className="mb-3 space-y-2">
        <div className={activityRowClassName}>
          <ActivityFace
            icon={AiImageIcon}
            label={drawing}
            detail={activity.model || null}
            status="running"
          />
          {/* Apart from the face, whose detail rolls on every change: a clock would roll each second. */}
          {elapsed >= 1000 ? (
            <span className="-ml-0.5 shrink-0 tabular-nums">· {formatDuration(elapsed)}</span>
          ) : null}
        </div>
        <ImageGrid count={activity.requested}>
          {Array.from({ length: Math.max(1, activity.requested) }, (_, index) => (
            <div
              key={index}
              role="img"
              aria-label={drawing}
              style={{ aspectRatio: cssRatio(activity.aspectRatio) }}
              className="bg-muted relative flex w-full items-center justify-center overflow-hidden rounded-2xl"
            >
              {/* The model's newest draft, soft until the finished image takes its place. */}
              {preview && index === 0 ? (
                <img
                  // A new draft remounts to fade in; the tail of its bytes tells drafts apart.
                  key={preview.slice(-32)}
                  src={preview}
                  alt=""
                  className="animate-in fade-in absolute inset-0 size-full scale-105 object-cover blur-md duration-500 motion-reduce:animate-none"
                />
              ) : (
                <HugeiconsIcon
                  icon={AiImageIcon}
                  strokeWidth={2}
                  className="text-muted-foreground/50 relative size-8"
                  aria-hidden
                />
              )}
              <div className="surface-shimmer absolute inset-0" />
            </div>
          ))}
        </ImageGrid>
      </div>
    );

  if (files.length === 0) {
    const label = activity.refusal
      ? activity.model
        ? m.images_activity_declined({ model: activity.model })
        : m.images_activity_declined_unnamed()
      : (activity.editing ? m.images_activity_edit_failed : m.images_activity_create_failed)({
          count,
        });
    const note = activity.refusal ?? activity.error;
    return (
      <div className="mb-3 space-y-1">
        <div className={activityRowClassName}>
          <ActivityFace icon={AiImageIcon} label={label} status="failed" />
        </div>
        {note ? (
          // The row already carries the warning; the provider's words sit under its label.
          <p className="text-muted-foreground pl-5.5 text-xs [overflow-wrap:anywhere]">{note}</p>
        ) : null}
      </div>
    );
  }

  return (
    <figure className="mb-3 space-y-1.5">
      <ImageGrid count={files.length}>
        {files.map((file) => (
          <GeneratedImage key={file.attachment.id} file={file} model={activity.model} />
        ))}
      </ImageGrid>
      <figcaption className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs">
        <span>
          {(activity.editing ? m.images_activity_edited_with : m.images_activity_made_with)({
            model: activity.model,
          })}
        </span>
        {activity.quality ? (
          <span className="flex items-center gap-1.5">
            <span aria-hidden>·</span>
            <span>{QUALITY_LABELS[activity.quality]()}</span>
          </span>
        ) : null}
        {activity.adjustments?.map((line) => (
          <span key={line} className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden>·</span>
            <span className="[overflow-wrap:anywhere]">{line}</span>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

function ImageGrid({ count, children }: { count: number; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "grid gap-2",
        count > 1 ? "max-w-2xl grid-cols-2" : "max-w-md grid-cols-1",
        // An odd count leads with one wide image, so no cell is left empty.
        count > 1 && count % 2 === 1 && "[&>:first-child]:col-span-2",
      )}
    >
      {children}
    </div>
  );
}

/** Puts the image into the composer as a reference the model can pass back to edit. */
const useEditImage = (file: AssistantFile) => {
  const actions = use(GenuiActionsContext);
  if (!actions || actions.disabled) return null;
  return () =>
    actions.offer(
      `${tagMarkup({ kind: "image", id: file.attachment.id, name: file.attachment.fileName })} `,
    );
};

function GeneratedImage({ file, model }: { file: AssistantFile; model: string }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const { attachment } = file;
  const size = attachment.dimensions;
  const url = attachmentUrl(attachment.id);
  const edit = useEditImage(file);

  if (failed)
    return (
      <p role="alert" className="text-muted-foreground bg-muted rounded-2xl p-4 text-sm">
        {m.images_image_failed()}
      </p>
    );

  return (
    <div className="group/image relative">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={m.images_image_preview({ fileName: attachment.fileName })}
        className="focus-visible:ring-ring/30 block overflow-hidden rounded-2xl outline-none focus-visible:ring-3"
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          setPreviewOpen(true);
        }}
      >
        <img
          src={url}
          alt={model ? m.images_image_alt({ model }) : m.images_image_alt_unnamed()}
          // Its box is held from the stored size, so the grid does not jump when it arrives.
          width={size?.width}
          height={size?.height}
          onError={() => setFailed(true)}
          className="bg-muted block h-auto max-h-144 w-full object-contain"
        />
      </a>
      <div className="pointer-events-none absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity group-focus-within/image:pointer-events-auto group-focus-within/image:opacity-100 group-hover/image:pointer-events-auto group-hover/image:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 motion-reduce:transition-none">
        {edit ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="floating"
                  size="icon-sm"
                  aria-label={m.images_image_edit()}
                  onClick={edit}
                />
              }
            >
              <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} aria-hidden />
            </TooltipTrigger>
            <TooltipContent>{m.common_edit()}</TooltipContent>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <a
                href={url}
                download={attachment.fileName}
                aria-label={m.images_image_download()}
                className={buttonVariants({ variant: "floating", size: "icon-sm" })}
              />
            }
          >
            <HugeiconsIcon icon={Download01Icon} strokeWidth={2} aria-hidden />
          </TooltipTrigger>
          <TooltipContent>{m.common_download()}</TooltipContent>
        </Tooltip>
      </div>
      <AttachmentPreviewDialog
        target={{ fileName: attachment.fileName, size: attachment.size, kind: "image", url }}
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        actions={
          <>
            {edit ? (
              <PreviewAction
                icon={PencilEdit02Icon}
                label={m.common_edit()}
                onClick={() => {
                  edit();
                  setPreviewOpen(false);
                }}
              />
            ) : null}
            <PreviewAction
              icon={Download01Icon}
              label={m.common_download()}
              href={url}
              download={attachment.fileName}
            />
          </>
        }
      />
    </div>
  );
}
