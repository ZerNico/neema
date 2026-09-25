import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { Suspense, lazy, useMemo, useState } from "react";
import { AssistantMarkdown } from "~/modules/chat/ui/assistant-markdown.tsx";
import { relativeAgeLabel } from "~/modules/chat/ui/timestamps.ts";
import { Button } from "~/ui/primitives/button";
import { FieldError } from "~/ui/primitives/field";
import { Spinner } from "~/ui/primitives/spinner";
import { motionEase, useAppReducedMotion } from "~/ui/motion";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { ViewToggle } from "~/ui/view-toggle.tsx";
import {
  DocumentTaskScope,
  documentTaskMarkdownComponents,
  renderedDocumentSource,
} from "./document-task-markdown.tsx";
import type { DocumentController as Controller } from "../client/use-document.ts";

// CodeMirror and its Yjs binding load with the first source view, not the chat.
const DocumentSourceEditor = lazy(() => import("./document-source-editor.tsx"));

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

export function DocumentPanelActions({
  controller,
  preview,
  onPreviewChange,
}: {
  controller: Controller;
  preview: boolean;
  onPreviewChange: (preview: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center justify-between gap-2">
      <ViewToggle preview={preview} sourceLabel="Source" onChange={onPreviewChange} />
      <div className="flex min-w-0 items-center gap-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Copy document"
                onClick={() => {
                  void navigator.clipboard.writeText(controller.content).then(() => {
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
  preview,
}: {
  controller: Controller;
  preview: boolean;
}) {
  const reducedMotion = useAppReducedMotion();
  // Marker spans are injected for rendering only; the stored source never has them.
  const source = useMemo(() => renderedDocumentSource(controller.content), [controller.content]);

  return (
    <div className="min-w-0">
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
      <div className="min-w-0 space-y-3">
        {controller.error ? <FieldError>{controller.error}</FieldError> : null}
        <div className="min-w-0">
          {preview ? (
            <DocumentTaskScope
              disabled={!controller.sync || !controller.document?.canEdit}
              onToggle={controller.toggleTask}
            >
              <AssistantMarkdown
                content={source}
                components={documentTaskMarkdownComponents}
                streaming={false}
              />
            </DocumentTaskScope>
          ) : controller.sync ? (
            // The editor carries its own 1rem gutter, which on top of the panel's
            // padding indented source a step further than the preview beside it.
            // Pulling only the editor to the panel edge lets that gutter be the
            // padding; the fallback has none, so it keeps the panel's.
            <Suspense
              fallback={
                <Spinner aria-label="Loading source editor" className="text-muted-foreground" />
              }
            >
              {/* Bounded to the rail rather than the editor's default 40rem: it
              uses the height it has while keeping its own scrollbars, the
              sideways one included, on screen. */}
              <div className="-mx-4 [--editor-max-height:calc(100vh-13rem)] [--editor-min-height:12rem]">
                <DocumentSourceEditor
                  key={controller.sync.doc.guid}
                  sync={controller.sync}
                  readOnly={!controller.document?.canEdit}
                />
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
