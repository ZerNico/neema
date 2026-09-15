import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { AssistantMarkdown } from "~/modules/chat/ui/assistant-markdown.tsx";
import { relativeAgeLabel } from "~/modules/chat/ui/timestamps.ts";
import { Button } from "~/ui/primitives/button";
import { FieldError } from "~/ui/primitives/field";
import { Spinner } from "~/ui/primitives/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { ViewToggle } from "~/ui/view-toggle.tsx";
import {
  DocumentTaskScope,
  documentTaskMarkdownComponents,
  renderedDocumentSource,
} from "./document-task-markdown.tsx";
import type { useDocument } from "../client/use-document.ts";

const TextEditor = lazy(() => import("~/modules/skills/ui/text-editor.tsx"));
type Controller = ReturnType<typeof useDocument>;

export const documentSubtitle = (controller: Controller) => {
  const document = controller.document;
  if (!document) return "Document";
  const editor = document.lastEditedBy === "user" ? "you" : "the assistant";
  const age = relativeAgeLabel(document.updatedAt);
  return [`Edited by ${editor}`, age].filter(Boolean).join(" · ");
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

/**
 * Holds the editor's text itself. The panel stores this element as a snapshot
 * and re-renders it whenever anything else in the chat does, so driving
 * CodeMirror straight from the controller's copy would replay a value one
 * render old and swallow the newest keystrokes. Typing updates this state and
 * the controller together; only an `external` epoch replaces the text.
 */
function DocumentSourceEditor({ controller }: { controller: Controller }) {
  const { content, external, setContent, locked } = controller;
  // Mounts on the source as it stands, including edits made before this editor
  // existed; `external` only carries later replacements.
  const [text, setText] = useState(content);
  const applied = useRef(external.epoch);
  useEffect(() => {
    if (external.epoch === applied.current) return;
    applied.current = external.epoch;
    setText(external.text);
  }, [external]);
  return (
    <TextEditor
      value={text}
      onChange={(value) => {
        setText(value);
        setContent(value);
      }}
      path="document.md"
      label="Document source"
      readOnly={locked}
    />
  );
}

export function DocumentPanelBody({
  controller,
  preview,
}: {
  controller: Controller;
  preview: boolean;
}) {
  // Marker spans are injected for rendering only; the stored source never has them.
  const source = useMemo(() => renderedDocumentSource(controller.content), [controller.content]);

  return (
    <div className="min-w-0 space-y-3">
      {controller.locked ? (
        <p className="text-muted-foreground text-xs">
          Read-only while the assistant is answering.
        </p>
      ) : null}
      {controller.conflict ? (
        <section className="space-y-2 rounded-2xl border p-3" aria-label="Document conflict">
          <p className="text-sm font-medium">Changed while you were editing</p>
          <p className="text-muted-foreground text-xs">
            Your source is still here. Choose which whole document to keep.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => controller.resolve("local")}>
              Keep mine
            </Button>
            <Button size="sm" variant="outline" onClick={() => controller.resolve("remote")}>
              Take theirs
            </Button>
          </div>
        </section>
      ) : null}
      {controller.error ? <FieldError className="text-sm">{controller.error}</FieldError> : null}
      {preview ? (
        <DocumentTaskScope disabled={controller.locked} onToggle={controller.toggleTask}>
          <AssistantMarkdown
            content={source}
            components={documentTaskMarkdownComponents}
            streaming={false}
          />
        </DocumentTaskScope>
      ) : (
        <Suspense fallback={<Spinner aria-label="Loading source editor" />}>
          <DocumentSourceEditor controller={controller} />
        </Suspense>
      )}
    </div>
  );
}
