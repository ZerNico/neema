import { CodeIcon, Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { Suspense, lazy, useState } from "react";
import { relativeAgeLabel } from "~/modules/chat/ui/timestamps.ts";
import { Button } from "~/ui/primitives/button";
import { FieldError } from "~/ui/primitives/field";
import { Spinner } from "~/ui/primitives/spinner";
import { Toggle } from "~/ui/primitives/toggle";
import { motionEase, useAppReducedMotion } from "~/ui/motion";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { cn } from "~/ui/utils";
import type { DocumentController as Controller } from "../client/use-document.ts";
import type { DocumentEditorMode } from "./rich-editor/document-editor.tsx";

// The editor and its schema load with the first open document, not the chat.
const DocumentEditor = lazy(() => import("./rich-editor/document-editor.tsx"));

export const documentSubtitle = (controller: Controller, userId?: string) => {
  const document = controller.document;
  if (!document) return "Document";
  const age = relativeAgeLabel(document.updatedAt);
  // Kept short: the panel header gives the title whatever this leaves. In a
  // project someone else's edit goes unnamed rather than crowding it out.
  const editor =
    document.lastEditedBy === "model"
      ? "by the assistant"
      : !document.projectId || !document.lastEditorUserId || document.lastEditorUserId === userId
        ? "by you"
        : null;
  return [
    // One word, so a shared document reads apart from this chat's own.
    document.projectId ? "Project" : null,
    document.canEdit ? null : "View only",
    ["Edited", editor, age].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(" · ");
};

/**
 * What is on screen, not the stored copy a second behind it: an open
 * connection's tree is read as Markdown, loading the schema only then.
 */
const copyMarkdown = async (controller: Controller) => {
  const sync = controller.sync;
  const text = sync
    ? (await import("../editor/markdown.ts")).readMarkdown(sync.doc)
    : controller.content;
  await navigator.clipboard.writeText(text);
};

export function DocumentPanelActions({
  controller,
  mode,
  onModeChange,
  toolbarSlot,
}: {
  controller: Controller;
  mode: DocumentEditorMode;
  onModeChange: (mode: DocumentEditorMode) => void;
  /** Receives the element the editor puts its formatting controls in. */
  toolbarSlot: (element: HTMLElement | null) => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      {/* The editor's formatting fills the row; the view and Copy sit at its end. */}
      <div ref={toolbarSlot} className="flex min-w-0 flex-1" />
      <div className="flex shrink-0 items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                size="icon"
                variant="toolbar"
                aria-label="Show Markdown"
                pressed={mode === "source"}
                onPressedChange={(pressed) => onModeChange(pressed ? "source" : "live")}
              />
            }
          >
            <HugeiconsIcon icon={CodeIcon} strokeWidth={2} />
          </TooltipTrigger>
          <TooltipContent>
            {mode === "source" ? "Back to the editor" : "Show Markdown"}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Copy document"
                className="text-muted-foreground"
                onClick={() => {
                  void copyMarkdown(controller).then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1_500);
                  });
                }}
              />
            }
          >
            <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} strokeWidth={2} />
          </TooltipTrigger>
          <TooltipContent>{copied ? "Copied" : "Copy document"}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

export function DocumentPanelBody({
  controller,
  mode,
  toolbarSlot,
}: {
  controller: Controller;
  mode: DocumentEditorMode;
  toolbarSlot: HTMLElement | null;
}) {
  const reducedMotion = useAppReducedMotion();

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {/* Outside the spacing rhythm below: a collapsing sibling margin would
          drop the body by a step the moment the notice starts leaving. */}
      <AnimatePresence initial={false}>
        {controller.status === "offline" ? (
          <m.div
            key="offline"
            className="overflow-hidden"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: reducedMotion ? 0 : 0.18, ease: motionEase }}
          >
            <p className="text-muted-foreground flex items-center gap-2 pb-3 text-xs">
              <Spinner className="size-3" aria-hidden />
              Reconnecting. Your edits are kept and sent once it’s back.
            </p>
          </m.div>
        ) : null}
      </AnimatePresence>
      <div className="flex min-w-0 flex-1 flex-col space-y-3">
        {controller.error ? <FieldError>{controller.error}</FieldError> : null}
        <div className="flex min-w-0 flex-1 flex-col">
          {controller.sync ? (
            // The editor pads its own text, so it is pulled to the panel's
            // edges; the fallback keeps the panel's padding.
            <Suspense
              fallback={<Spinner aria-label="Loading editor" className="text-muted-foreground" />}
            >
              {/* Fills the rest of the panel, edge to edge, whatever the text's
              length, so the editor's own scrollbars sit on the panel's edges
              instead of under the last line. A notice above keeps its gap. */}
              <div
                className={cn(
                  "relative -mx-4 -mb-4 min-h-48 flex-1",
                  !controller.error && controller.status !== "offline" && "-mt-4",
                )}
              >
                <div className="absolute inset-0">
                  <DocumentEditor
                    key={controller.sync.doc.guid}
                    sync={controller.sync}
                    mode={mode}
                    readOnly={!controller.document?.canEdit}
                    toolbarSlot={toolbarSlot}
                  />
                </div>
              </div>
            </Suspense>
          ) : (
            <Spinner aria-label="Connecting to document" className="text-muted-foreground" />
          )}
        </div>
      </div>
    </div>
  );
}
