import {
  Copy01Icon,
  Download04Icon,
  MoreVerticalIcon,
  PencilEdit02Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { Suspense, lazy, useState } from "react";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { FieldError } from "~/ui/primitives/field";
import { Spinner } from "~/ui/primitives/spinner";
import { motionEase } from "~/ui/motion-presets.ts";
import { useAppReducedMotion } from "~/ui/reduced-motion.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { cn } from "~/ui/utils";
import type { DocumentController as Controller } from "../client/use-document.ts";
import type { EditorHooks } from "./rich-editor/editor-hooks.ts";
import { RenameDocumentDialog } from "./rename-document-dialog.tsx";

// The editor and its schema load with the first open document, not the chat.
const DocumentEditor = lazy(() => import("./rich-editor/document-editor.tsx"));
// Comments need the editor's schema too, so they load with it.
const CommentsPopover = lazy(() =>
  import("./comments-popover.tsx").then((module) => ({ default: module.CommentsPopover })),
);

/** Markdown of what is on screen, made only when asked; the schema loads then. */
const markdownOf = async (sync: NonNullable<Controller["sync"]>) =>
  (await import("../editor/markdown.ts")).toMarkdown(sync.editor.state.doc);
const exportAs = async (controller: Controller, format: "pdf" | "markdown") => {
  const sync = controller.sync;
  if (!sync) return;
  const title = controller.document?.title ?? "Document";
  const { printDocument, downloadMarkdown } = await import("./export.ts");
  if (format === "pdf") printDocument(sync.editor, title);
  else downloadMarkdown(await markdownOf(sync), title);
};

export function DocumentPanelActions({
  controller,
  toolbarSlot,
}: {
  controller: Controller;
  /** Receives the element the editor puts its formatting controls in. */
  toolbarSlot: (element: HTMLElement | null) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const document = controller.document;
  return (
    <div className="flex items-center gap-2">
      {/* The editor's formatting fills the row; Copy sits at its end. */}
      <div ref={toolbarSlot} className="flex min-w-0 flex-1" />
      <div className="flex shrink-0 items-center gap-0.5">
        {controller.sync ? (
          <Suspense fallback={null}>
            <CommentsPopover
              editor={controller.sync.editor}
              discussion={controller.discussion}
              canEdit={controller.document?.canEdit ?? false}
            />
          </Suspense>
        ) : null}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              render={
                <DropdownMenuTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Document actions"
                      className="text-muted-foreground"
                    />
                  }
                />
              }
            >
              <HugeiconsIcon icon={MoreVerticalIcon} strokeWidth={2} />
            </TooltipTrigger>
            <TooltipContent>More</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-52">
            {document?.canEdit ? (
              <>
                <DropdownMenuItem onClick={() => setRenaming(true)}>
                  <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuItem
              disabled={!controller.sync}
              onClick={() => void exportAs(controller, "pdf")}
            >
              <HugeiconsIcon icon={Download04Icon} strokeWidth={2} />
              Export as PDF
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!controller.sync}
              onClick={() => void exportAs(controller, "markdown")}
            >
              <HugeiconsIcon icon={Download04Icon} strokeWidth={2} />
              Export as Markdown
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {document?.canEdit ? (
          <RenameDocumentDialog document={document} open={renaming} onOpenChange={setRenaming} />
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Copy document"
                className="text-muted-foreground"
                disabled={!controller.sync}
                onClick={() => {
                  const sync = controller.sync;
                  if (!sync) return;
                  void markdownOf(sync)
                    .then((text) => navigator.clipboard.writeText(text))
                    .then(() => {
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
  toolbarSlot,
  hooks,
}: {
  controller: Controller;
  toolbarSlot: HTMLElement | null;
  hooks?: EditorHooks | undefined;
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
        {controller.recovered ? <RecoveredChanges controller={controller} /> : null}
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
                    key={controller.documentId}
                    sync={controller.sync}
                    readOnly={!controller.document?.canEdit}
                    toolbarSlot={toolbarSlot}
                    hooks={hooks}
                    discussion={controller.discussion}
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

/**
 * Text from changes made offline that the document no longer had a place
 * for, kept until the person copies or dismisses it rather than dropped.
 */
function RecoveredChanges({ controller }: { controller: Controller }) {
  const text = controller.recovered ?? "";
  return (
    <div role="status" className="bg-muted space-y-2 rounded-xl p-3 text-sm">
      <p className="font-medium">Some offline changes couldn’t be placed</p>
      <p className="text-muted-foreground line-clamp-4 whitespace-pre-wrap">{text}</p>
      <div className="flex gap-2">
        <Button
          size="xs"
          variant="outline"
          onClick={() => void navigator.clipboard.writeText(text)}
        >
          <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} data-icon="inline-start" />
          Copy
        </Button>
        <Button size="xs" variant="ghost" onClick={controller.dismissRecovered}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
