import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { Popover, PopoverContent } from "~/ui/primitives/popover";
import { commentsKey } from "../../client/comments-plugin.ts";
import type { DocumentDiscussion } from "../../client/use-document.ts";
import { commentAnchors } from "../../editor/comments.ts";
import { commentActions, setComments, shorten } from "../comment-actions.ts";
import { CommentInput, CommentThread } from "../comment-thread.tsx";

/** A box around a run of document positions, read fresh so the card follows scrolling. */
const rangeAnchor = (editor: Editor, from: number, to: number) => ({
  getBoundingClientRect: () => {
    const start = editor.view.coordsAtPos(from);
    const end = editor.view.coordsAtPos(to);
    const left = Math.min(start.left, end.left);
    const top = Math.min(start.top, end.top);
    return DOMRect.fromRect({
      x: left,
      y: top,
      width: Math.max(1, Math.max(start.right, end.right) - left),
      height: Math.max(start.bottom, end.bottom) - top,
    });
  },
});

/**
 * One comment, on its text: the thread a click on commented text opened, or
 * a new comment on the selection. The list of every thread lives in the
 * panel's header instead.
 */
export function CommentCard({
  editor,
  discussion,
  canEdit,
}: {
  editor: Editor;
  discussion: DocumentDiscussion;
  canEdit: boolean;
}) {
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const plugin = commentsKey.getState(current.state);
      const active = plugin?.active ?? null;
      return {
        active,
        compose: plugin?.compose ?? null,
        anchor: active ? (commentAnchors(current.state.doc).get(active) ?? null) : null,
      };
    },
  });
  const actions = canEdit ? commentActions(editor, discussion) : null;
  const root = state.active
    ? discussion.comments.find((each) => each.id === state.active && each.threadId === each.id)
    : undefined;
  const compose = state.compose;
  const range = compose ?? state.anchor;
  const open = range !== null && (state.compose !== null || root !== undefined);
  const anchor = range ? rangeAnchor(editor, range.from, range.to) : null;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        setComments(editor, state.compose ? { compose: null } : { active: null });
      }}
    >
      {/* A thread opens without taking focus, which would scroll the page to it; a new comment's field takes it. */}
      <PopoverContent
        anchor={anchor}
        align="start"
        className="w-80"
        initialFocus={compose !== null}
      >
        {compose && actions ? (
          <div className="flex flex-col gap-3">
            <div className="border-warning text-muted-foreground line-clamp-2 border-l-2 pl-2 text-xs">
              {shorten(editor.state.doc.textBetween(compose.from, compose.to, " ", " "), 160)}
            </div>
            <CommentInput
              placeholder="Add a comment"
              canAsk={actions.canAsk}
              askByDefault
              autoFocus
              onSubmit={(body, toAssistant) => actions.start(compose, body, toAssistant)}
            />
          </div>
        ) : root ? (
          <CommentThread
            root={root}
            replies={discussion.comments.filter(
              (each) => each.threadId === root.id && each.id !== root.id,
            )}
            anchored
            me={discussion.me}
            actions={actions}
            expanded
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
