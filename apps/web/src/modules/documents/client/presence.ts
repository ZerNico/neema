import type { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { DocumentPresence } from "../schema.ts";

/** Another editor's selection, already mapped onto this editor's document. */
export interface RemoteCaret {
  clientId: string;
  anchor: number;
  head: number;
  user: DocumentPresence["user"];
}

const key = new PluginKey<DecorationSet>("documentPresence");

const caret = (clientId: string, user: DocumentPresence["user"]) => {
  const element = document.createElement("span");
  element.className = "collaboration-carets__caret";
  element.dataset.caretClient = clientId;
  element.style.borderColor = user.color;
  const label = element.appendChild(document.createElement("div"));
  label.className = "collaboration-carets__label";
  label.style.backgroundColor = user.color;
  label.textContent = user.name;
  return element;
};

const clamp = (doc: Node, position: number) => Math.max(0, Math.min(position, doc.content.size));

const decorate = (doc: Node, carets: ReadonlyArray<RemoteCaret>) =>
  DecorationSet.create(
    doc,
    carets.flatMap(({ clientId, anchor, head, user }) => {
      const from = clamp(doc, Math.min(anchor, head));
      const to = clamp(doc, Math.max(anchor, head));
      const marks = [
        Decoration.widget(clamp(doc, head), () => caret(clientId, user), {
          key: clientId,
          side: 10,
        }),
      ];
      if (from < to)
        marks.push(Decoration.inline(from, to, { style: `background-color: ${user.colorLight}` }));
      return marks;
    }),
  );

/**
 * Other people's cursors as decorations. The connection maps each one onto
 * this document and hands the whole set over through `showCarets`; between
 * updates, the decorations follow local edits like any other.
 */
export const presencePlugin = () =>
  new Plugin<DecorationSet>({
    key,
    state: {
      init: () => DecorationSet.empty,
      apply: (tr, set) => {
        const carets = tr.getMeta(key) as ReadonlyArray<RemoteCaret> | undefined;
        return carets ? decorate(tr.doc, carets) : set.map(tr.mapping, tr.doc);
      },
    },
    props: { decorations: (state) => key.getState(state) },
  });

/** A transaction on `state` that replaces every shown caret. */
export const showCarets = (state: EditorState, carets: ReadonlyArray<RemoteCaret>) =>
  state.tr.setMeta(key, carets).setMeta("addToHistory", false);
