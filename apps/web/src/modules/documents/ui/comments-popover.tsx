import { Comment01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { useState } from "react";
import { Button } from "~/ui/primitives/button";
import { Popover, PopoverContent, PopoverTrigger } from "~/ui/primitives/popover";
import { Separator } from "~/ui/primitives/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { cn } from "~/ui/utils";
import type { DocumentDiscussion } from "../client/use-document.ts";
import { commentAnchors } from "../editor/comments.ts";
import type { DocumentComment } from "../schema.ts";
import { commentActions, openThread } from "./comment-actions.ts";
import { CommentThread } from "./comment-thread.tsx";

/**
 * Every comment on the document, from the panel's header: open threads in
 * reading order, then resolved ones on request. Choosing a thread goes to its
 * text and opens it there; one whose text is gone opens in the list.
 */
export function CommentsPopover({
  editor,
  discussion,
  canEdit,
}: {
  editor: Editor;
  discussion: DocumentDiscussion;
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const anchors = useEditorState({
    editor,
    selector: ({ editor: current }) => commentAnchors(current.state.doc),
  });
  const actions = canEdit ? commentActions(editor, discussion) : null;
  const roots = discussion.comments.filter((each) => each.id === each.threadId);
  const openRoots = roots
    .filter((root) => !root.resolvedAt)
    .toSorted(
      (a, b) =>
        (anchors.get(a.id)?.from ?? Number.MAX_SAFE_INTEGER) -
        (anchors.get(b.id)?.from ?? Number.MAX_SAFE_INTEGER),
    );
  const resolved = roots.filter((root) => root.resolvedAt);
  const repliesOf = (root: DocumentComment) =>
    discussion.comments.filter((each) => each.threadId === root.id && each.id !== root.id);
  const choose = (root: DocumentComment) => {
    if (!root.resolvedAt && openThread(editor, root.id)) setOpen(false);
    else setExpanded((current) => (current === root.id ? null : root.id));
  };
  const thread = (root: DocumentComment) => (
    <div
      key={root.id}
      className={cn(
        "flex flex-col gap-2 rounded-2xl p-2",
        expanded === root.id ? "bg-muted/60" : "hover:bg-muted/40",
      )}
    >
      <CommentThread
        root={root}
        replies={repliesOf(root)}
        anchored={anchors.has(root.id)}
        me={discussion.me}
        actions={actions}
        expanded={expanded === root.id}
        onQuoteClick={() => choose(root)}
      />
      {expanded !== root.id && !root.resolvedAt && actions ? (
        <Button size="xs" variant="ghost" className="self-start" onClick={() => choose(root)}>
          Reply
        </Button>
      ) : null}
    </div>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Comments${openRoots.length ? `, ${openRoots.length} open` : ""}`}
                  className="text-muted-foreground relative"
                />
              }
            />
          }
        >
          <HugeiconsIcon icon={Comment01Icon} strokeWidth={2} />
          {openRoots.length ? (
            <span className="bg-primary text-primary-foreground absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full text-[0.625rem] font-medium">
              {openRoots.length > 9 ? "9+" : openRoots.length}
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipContent>Comments</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-96">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Comments</h2>
          {resolved.length ? (
            <Button size="xs" variant="ghost" onClick={() => setShowResolved((shown) => !shown)}>
              {showResolved ? "Hide resolved" : `Resolved (${resolved.length})`}
            </Button>
          ) : null}
        </div>
        <div className="flex max-h-[min(32rem,65vh)] flex-col gap-1 overflow-y-auto">
          {openRoots.length ? (
            openRoots.map(thread)
          ) : (
            <p className="text-muted-foreground py-6 text-center text-sm">
              {canEdit ? "No open comments. Select text to add one." : "No open comments."}
            </p>
          )}
          {showResolved && resolved.length ? (
            <>
              <Separator />
              {resolved.map(thread)}
            </>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
