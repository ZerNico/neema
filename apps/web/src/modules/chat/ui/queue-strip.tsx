import {
  ArrowTurnForwardIcon,
  ArrowUp02Icon,
  Delete02Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import { tagWords } from "../tags.ts";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { useState } from "react";
import type { Attachment } from "~/modules/attachments/schema.ts";
import { attachmentUrl } from "~/modules/attachments/client/use-attachment-uploads.ts";
import { AttachmentChip, AttachmentChipRow } from "~/modules/attachments/ui/attachment-chip.tsx";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { collapseMotion } from "~/ui/motion-presets.ts";
import { useAppReducedMotion } from "~/ui/reduced-motion.ts";
import { cn } from "~/ui/utils";

/** What the strip renders; the loader row carries more, none of it visual. */
export interface QueuedMessage {
  id: string;
  content: string;
  lastError: string | null;
  attachments: ReadonlyArray<Attachment>;
}

/** A row's name for buttons and truncation: its words, or its files when it has none. */
const queuedLabel = (entry: QueuedMessage) =>
  tagWords(entry.content).trim() || entry.attachments.map((file) => file.fileName).join(", ");

/**
 * Future turns sit immediately above the composer, not in the virtualized
 * transcript. Every action belongs to one queued row: steering and editing are
 * decisions made after seeing the entry in context, and removal takes the
 * whole row with its files.
 */
export function QueueStrip({
  entries,
  generating,
  steeringIds,
  editingId,
  editBlocked,
  paused,
  onSteer,
  onRemove,
  onEdit,
  onSendNow,
  sendNowBlocked,
  onDispatch,
}: {
  entries: ReadonlyArray<QueuedMessage>;
  generating: boolean;
  /** Entries steered into the running answer: they go in at its next step. */
  steeringIds: ReadonlySet<string>;
  /** The row open in the composer, whose actions wait until the edit ends. */
  editingId: string | null;
  /** Why Edit is unavailable: the composer holds a draft of its own. */
  editBlocked: string | null;
  /**
   * Why an idle queue is not moving. `canDispatch` is false when starting it
   * by hand could not work either, such as Work outside the desktop app.
   */
  paused: { reason: string; canDispatch: boolean } | null;
  onSteer: (entryId: string) => void;
  onRemove: (entryId: string) => void;
  onEdit: (entryId: string) => void;
  /** Stops a running answer if there is one, then sends this entry. */
  onSendNow: (entryId: string) => void;
  /** Why Send now is unavailable here, such as Work outside the desktop app. */
  sendNowBlocked: string | null;
  onDispatch: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const collapse = collapseMotion(useAppReducedMotion());
  const shown = expanded ? entries : entries.slice(0, 3);
  // The rows already say what is queued, so a heading only earns its line
  // when there is news: the queue is waiting on something.
  const waiting = !generating && paused ? paused : null;
  const count = `${entries.length} message${entries.length === 1 ? "" : "s"} queued`;
  return (
    <div className="mx-3 -mb-3 flex">
      <div className="bg-muted/60 text-muted-foreground flex min-w-0 flex-1 flex-col rounded-t-composer border border-b-0 px-3 pt-1 pb-3.5 text-xs">
        {waiting ? (
          <div className="flex items-center justify-between gap-3 py-0.5">
            <span role="status">{waiting.reason}</span>
            {waiting.canDispatch ? (
              <Button size="xs" variant="ghost" onClick={onDispatch} disabled={editingId !== null}>
                Send next
              </Button>
            ) : null}
          </div>
        ) : (
          <span role="status" className="sr-only">
            {count}
          </span>
        )}
        <ul role="list" aria-label={count} className="flex flex-col divide-y">
          <AnimatePresence initial={false}>
            {shown.map((entry, index) => {
              const label = queuedLabel(entry);
              const editing = entry.id === editingId;
              return (
                <m.li key={entry.id} {...collapse} className="min-w-0">
                  <div className="flex min-w-0 flex-col gap-1 py-1">
                    <div className="flex min-w-0 items-center gap-2">
                      {/* Order only means something once there are two. */}
                      {entries.length > 1 ? (
                        <span className="text-muted-foreground/70 tabular-nums">{index + 1}</span>
                      ) : null}
                      <span
                        className={cn("min-w-0 flex-1 truncate", !entry.content.trim() && "italic")}
                        title={label}
                      >
                        {label}
                      </span>
                      {editing ? <span className="text-foreground shrink-0">Editing</span> : null}
                      {entry.lastError ? (
                        <span className="text-destructive min-w-0 truncate" title={entry.lastError}>
                          {entry.lastError}
                        </span>
                      ) : null}
                      {generating && !editing && steeringIds.has(entry.id) ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={<span className="text-foreground shrink-0 px-1" tabIndex={0} />}
                          >
                            Sends at the next step
                          </TooltipTrigger>
                          <TooltipContent>
                            If this answer finishes first, it’s sent right after.
                          </TooltipContent>
                        </Tooltip>
                      ) : null}
                      {generating && !editing && !steeringIds.has(entry.id) ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                size="xs"
                                variant="ghost"
                                aria-label={`Steer: ${label}`}
                                onClick={() => onSteer(entry.id)}
                              />
                            }
                          >
                            <HugeiconsIcon
                              icon={ArrowTurnForwardIcon}
                              strokeWidth={2}
                              className="size-3.5"
                            />
                            Steer
                          </TooltipTrigger>
                          <TooltipContent>Send into this response at its next step</TooltipContent>
                        </Tooltip>
                      ) : null}
                      {editing ? null : (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                aria-label={`Remove: ${label}`}
                                onClick={() => onRemove(entry.id)}
                              />
                            }
                          >
                            <HugeiconsIcon
                              icon={Delete02Icon}
                              strokeWidth={2}
                              className="size-3.5"
                            />
                          </TooltipTrigger>
                          <TooltipContent>
                            {entry.attachments.length > 0
                              ? "Remove from queue and delete its files"
                              : "Remove from queue"}
                          </TooltipContent>
                        </Tooltip>
                      )}
                      {editing ? null : (
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                aria-label={`More actions: ${label}`}
                              />
                            }
                          >
                            <HugeiconsIcon
                              icon={MoreHorizontalIcon}
                              strokeWidth={2}
                              className="size-3.5"
                            />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-56">
                            <DropdownMenuItem
                              disabled={sendNowBlocked !== null}
                              onClick={() => onSendNow(entry.id)}
                            >
                              <HugeiconsIcon icon={ArrowUp02Icon} strokeWidth={2} />
                              {/* The one way to cut an answer short for a queued message. */}
                              {generating ? "Stop and send now" : "Send now"}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={editBlocked !== null}
                              onClick={() => onEdit(entry.id)}
                            >
                              <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
                              Edit
                            </DropdownMenuItem>
                            {[sendNowBlocked, editBlocked].filter(Boolean).map((reason) => (
                              <p
                                key={reason}
                                className="text-muted-foreground px-2 pt-1 pb-1.5 text-xs"
                              >
                                {reason}
                              </p>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                    {entry.attachments.length > 0 ? (
                      <AttachmentChipRow>
                        {entry.attachments.map((file) => (
                          <AttachmentChip
                            key={file.id}
                            item={{
                              fileName: file.fileName,
                              size: file.size,
                              kind: file.kind,
                              previewUrl: file.kind === "image" ? attachmentUrl(file.id) : null,
                            }}
                            href={attachmentUrl(file.id)}
                            preview={attachmentUrl(file.id)}
                          />
                        ))}
                      </AttachmentChipRow>
                    ) : null}
                  </div>
                </m.li>
              );
            })}
          </AnimatePresence>
        </ul>
        {entries.length > shown.length ? (
          <Button
            size="xs"
            variant="ghost"
            className="self-start"
            onClick={() => setExpanded(true)}
          >
            <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} className="size-3.5" />
            {entries.length - shown.length} more
          </Button>
        ) : null}
      </div>
    </div>
  );
}
