import type { Editor } from "@tiptap/core";

/** Someone a mention can name: an account, shown by name. */
export interface MentionCandidate {
  id: string;
  label: string;
  detail?: string | undefined;
}
/**
 * What the panel lends its editor: who can be mentioned, and how to ask the
 * assistant to write at a spot. Kept per editor, since the editor outlives
 * the panel that mounts it.
 */
export interface EditorHooks {
  mentions: () => ReadonlyArray<MentionCandidate>;
  /**
   * Sends the request with these blocks selected; false when it cannot go
   * now (an answer is running). Null outside a chat.
   */
  ask: ((request: string, blocks: ReadonlyArray<string>) => Promise<boolean>) | null;
  /** Moves focus to the chat's input, the selection kept for the message. Null outside a chat. */
  focusComposer: (() => void) | null;
}
const hooks = new WeakMap<Editor, EditorHooks>();
const NONE: EditorHooks = { mentions: () => [], ask: null, focusComposer: null };

export const setEditorHooks = (editor: Editor, value: EditorHooks) => hooks.set(editor, value);
export const editorHooks = (editor: Editor) => hooks.get(editor) ?? NONE;
