import type { Editor } from "@tiptap/core";
import { toast } from "sonner";
import { uuidv7 } from "uuidv7";
import { toastError } from "~/ui/error-toast.ts";
import { commentsKey, type CommentsMeta } from "../client/comments-plugin.ts";
import type { DocumentDiscussion } from "../client/use-document.ts";
import { commentMessage } from "../comment-message.ts";
import { BLOCK_ID } from "../editor/block-ids.ts";
import { commentAnchors } from "../editor/comments.ts";
import { editorHooks } from "./rich-editor/editor-hooks.ts";

export const shorten = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;

/** The innermost block with an ID around `position`, which the message names. */
const blockAt = (editor: Editor, position: number) => {
  const $position = editor.state.doc.resolve(position);
  for (let depth = $position.depth; depth > 0; depth--) {
    const id = $position.node(depth).attrs[BLOCK_ID] as unknown;
    if (typeof id === "string") return id;
  }
  return null;
};

export const setComments = (editor: Editor, meta: CommentsMeta) =>
  editor.view.dispatch(editor.state.tr.setMeta(commentsKey, meta));

/** Moves the document to a thread's text and opens it there. */
export const openThread = (editor: Editor, threadId: string) => {
  const anchor = commentAnchors(editor.state.doc).get(threadId);
  if (!anchor) return false;
  editor.commands.setTextSelection(anchor.from);
  // The panel's own scroll area, which the editor's scroll-into-view does not move.
  // At once, not smoothly: the card opens on the text, and opened while the
  // text was still off screen it would be placed, and scrolled to, out there.
  const scroller = editor.view.dom.closest(".overflow-y-auto");
  if (scroller) {
    const at = editor.view.coordsAtPos(anchor.from);
    const frame = scroller.getBoundingClientRect();
    if (at.top < frame.top || at.bottom > frame.bottom)
      scroller.scrollTop += at.top - frame.top - frame.height / 3;
  }
  requestAnimationFrame(() => setComments(editor, { active: threadId }));
  return true;
};

/**
 * What a reader does with comments: start a thread on the text being
 * commented, reply, and send either to the assistant, which posts it as a
 * chat message naming the thread.
 */
export const commentActions = (editor: Editor, discussion: DocumentDiscussion) => {
  // Read when used: the panel lends its hooks after the editor first draws.
  const sendToAssistant = async (threadId: string, quote: string, body: string) => {
    const ask = editorHooks(editor).ask;
    const anchor = commentAnchors(editor.state.doc).get(threadId);
    const block = anchor ? blockAt(editor, anchor.from) : null;
    const sent = await ask?.(commentMessage(quote, body), {
      blocks: block ? [block] : [],
      thread: threadId,
    }).catch(() => false);
    if (!sent)
      toast.error("Couldn’t send it to the assistant", {
        description: "Try again once the current answer is done.",
      });
  };
  return {
    get canAsk() {
      return editorHooks(editor).ask !== null;
    },
    /** A new thread on `range`: the highlight goes on first, and comes off if it cannot be stored. */
    start: async (range: { from: number; to: number }, body: string, toAssistant: boolean) => {
      const thread = uuidv7();
      const quote = editor.state.doc.textBetween(range.from, range.to, " ", " ");
      const mark = editor.schema.marks.comment!.create({ thread });
      editor.view.dispatch(
        editor.state.tr.addMark(range.from, range.to, mark).setMeta(commentsKey, { compose: null }),
      );
      try {
        await discussion.comment(thread, body, { quote, toAssistant });
      } catch (error) {
        const anchor = commentAnchors(editor.state.doc).get(thread);
        if (anchor) editor.view.dispatch(editor.state.tr.removeMark(anchor.from, anchor.to, mark));
        toastError("Couldn’t add the comment.", error);
        return;
      }
      setComments(editor, { active: thread });
      if (toAssistant) await sendToAssistant(thread, quote, body);
    },
    reply: async (threadId: string, quote: string, body: string, toAssistant: boolean) => {
      try {
        await discussion.comment(threadId, body, { toAssistant });
      } catch (error) {
        toastError("Couldn’t send the reply.", error);
        return;
      }
      if (toAssistant) await sendToAssistant(threadId, quote, body);
    },
    resolve: (threadId: string, resolved: boolean) =>
      discussion
        .resolve(threadId, resolved)
        .catch((error: unknown) => toastError("Couldn’t update the thread.", error)),
    remove: (commentId: string) =>
      discussion
        .remove(commentId)
        .catch((error: unknown) => toastError("Couldn’t delete the comment.", error)),
  };
};
export type CommentActions = ReturnType<typeof commentActions>;
/** What a thread's card does with it, for any kind of document. */
export type ThreadActions = Pick<CommentActions, "canAsk" | "reply" | "resolve" | "remove">;
