import { act } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { QueryClient } from "@tanstack/react-query";
import { integrationDirectoryQuery } from "~/modules/integrations/client/directory.ts";
import {
  MENTION_NODE,
  TAG_NODE,
  docToText,
  textToDoc,
  type IntegrationMentionOptions,
} from "./composer-doc.tsx";

/** Tiptap keeps its editor on the editable element, which is how tests reach it. */
export const composerEditor = (field: HTMLElement) =>
  (field as HTMLElement & { editor: Editor }).editor;

/** How many tags (@integration, /skill, #collection) the draft holds, from the document. */
export function composerTagCount(field: HTMLElement) {
  let count = 0;
  composerEditor(field).state.doc.descendants((node) => {
    if (node.type.name === MENTION_NODE || node.type.name === TAG_NODE) count += 1;
  });
  return count;
}

/** Focuses now, where the editor's own focus command waits a frame. */
export function focusComposer(field: HTMLElement) {
  act(() => composerEditor(field).view.focus());
}

/** The draft as the composer hands it out. */
export const composerText = (field: HTMLElement) => docToText(composerEditor(field));

/** Replaces the whole draft, as selecting all and typing would, and emits the change. */
export function setComposerText(field: HTMLElement, text: string) {
  act(() => {
    const editor = composerEditor(field);
    // The names the composer itself would turn into tags.
    const mention = editor.extensionManager.extensions.find(
      (extension) => extension.name === MENTION_NODE,
    );
    const integrations =
      (mention?.options as IntegrationMentionOptions | undefined)?.integrations() ?? [];
    editor
      .chain()
      .focus()
      .setContent(textToDoc(text, integrations), { emitUpdate: true })
      .focus("end")
      .run();
  });
}

/**
 * Types at the caret one character at a time through ProseMirror's text-input
 * path, so input rules (a typed "@Name " tag) and list triggers see real typing.
 */
export function typeInComposer(field: HTMLElement, text: string) {
  const { view } = composerEditor(field);
  for (const character of text)
    act(() => {
      const { from, to } = view.state.selection;
      const handled = view.someProp("handleTextInput", (handler) =>
        handler(view, from, to, character, () => view.state.tr.insertText(character, from, to)),
      );
      if (!handled) view.dispatch(view.state.tr.insertText(character, from, to));
    });
}

/** Moves the caret to a character offset in a single-line draft. */
export function setComposerCaret(field: HTMLElement, offset: number) {
  act(() => {
    // Position 1 is the start of the first paragraph.
    composerEditor(field).commands.setTextSelection(offset + 1);
  });
}

/**
 * A query client that already knows this server's integrations, as the app's
 * does once loaded, so a tag can draw its logo and name without a request.
 */
export function clientWithIntegrations() {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(integrationDirectoryQuery.queryKey, [
    { id: "outline", kind: "outline", name: "Outline" },
  ]);
  return client;
}
