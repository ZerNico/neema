import type { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { DocumentPresence } from "../schema.ts";

/** Another editor's selection, already mapped onto this editor's document. */
export interface RemoteCaret {
  clientId: string;
  anchor: number;
  head: number;
  user: DocumentPresence["user"];
}

interface PresenceState {
  carets: ReadonlyArray<RemoteCaret>;
  /** The selections, as highlights in the text. */
  decorations: DecorationSet;
}

const key = new PluginKey<PresenceState>("documentPresence");

const clamp = (doc: Node, position: number) => Math.max(0, Math.min(position, doc.content.size));

const highlight = (doc: Node, carets: ReadonlyArray<RemoteCaret>) =>
  DecorationSet.create(
    doc,
    carets.flatMap(({ anchor, head, user }) => {
      const from = clamp(doc, Math.min(anchor, head));
      const to = clamp(doc, Math.max(anchor, head));
      return from < to
        ? [Decoration.inline(from, to, { style: `background-color: ${user.colorLight}` })]
        : [];
    }),
  );

const caretElement = (clientId: string, user: DocumentPresence["user"]) => {
  const element = document.createElement("div");
  element.className = "remote-caret";
  element.dataset.caretClient = clientId;
  element.style.backgroundColor = user.color;
  const label = element.appendChild(document.createElement("div"));
  label.className = "remote-caret__label";
  label.style.backgroundColor = user.color;
  label.textContent = user.name;
  return element;
};

/**
 * The carets themselves, laid over the text rather than inside it: an element
 * that stays the same between updates can slide to its new place, where one
 * redrawn in the text at every step would only jump.
 */
class CaretLayer {
  readonly #layer = document.createElement("div");
  readonly #carets = new Map<string, HTMLElement>();
  readonly #resize = new ResizeObserver(() => this.update(this.view));
  constructor(private view: EditorView) {
    this.#layer.className = "remote-carets";
    this.#layer.setAttribute("aria-hidden", "true");
    const parent = view.dom.parentElement;
    if (parent) {
      if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
      parent.append(this.#layer);
    }
    this.#resize.observe(view.dom);
    this.update(view);
  }

  update(view: EditorView) {
    this.view = view;
    const carets = key.getState(view.state)?.carets ?? [];
    const origin = this.#layer.getBoundingClientRect();
    const shown = new Set<string>();
    for (const { clientId, head, user } of carets) {
      let at: { left: number; top: number; bottom: number };
      try {
        // Measured against the text before, so a caret at a line's end stays on that line.
        at = view.coordsAtPos(clamp(view.state.doc, head), -1);
      } catch {
        continue;
      }
      shown.add(clientId);
      let element = this.#carets.get(clientId);
      const fresh = !element;
      if (!element) {
        element = caretElement(clientId, user);
        this.#carets.set(clientId, element);
        this.#layer.append(element);
      }
      element.style.backgroundColor = user.color;
      element.style.height = `${at.bottom - at.top}px`;
      element.style.transform = `translate(${at.left - origin.left - 1}px, ${at.top - origin.top}px)`;
      // A new caret appears where it is; only later moves slide.
      if (fresh) void element.offsetWidth;
      element.classList.add("is-placed");
    }
    for (const [clientId, element] of this.#carets)
      if (!shown.has(clientId)) {
        element.remove();
        this.#carets.delete(clientId);
      }
  }

  destroy() {
    this.#resize.disconnect();
    this.#layer.remove();
  }
}

/**
 * Other people's cursors. The connection maps each one onto this document and
 * hands the whole set over through `showCarets`; between updates, they follow
 * local edits like any other position.
 */
export const presencePlugin = () =>
  new Plugin<PresenceState>({
    key,
    state: {
      init: () => ({ carets: [], decorations: DecorationSet.empty }),
      apply: (tr, value) => {
        const next = tr.getMeta(key) as ReadonlyArray<RemoteCaret> | undefined;
        if (next) return { carets: next, decorations: highlight(tr.doc, next) };
        if (!tr.docChanged) return value;
        return {
          carets: value.carets.map((caret) => ({
            ...caret,
            anchor: tr.mapping.map(caret.anchor),
            head: tr.mapping.map(caret.head),
          })),
          decorations: value.decorations.map(tr.mapping, tr.doc),
        };
      },
    },
    view: (view) => new CaretLayer(view),
    props: { decorations: (state) => key.getState(state)?.decorations ?? null },
  });

/** A transaction on `state` that replaces every shown caret. */
export const showCarets = (state: EditorState, carets: ReadonlyArray<RemoteCaret>) =>
  state.tr.setMeta(key, carets).setMeta("addToHistory", false);

/** The carets as currently placed in `state`'s document. */
export const caretsOf = (state: EditorState) => key.getState(state)?.carets ?? [];
