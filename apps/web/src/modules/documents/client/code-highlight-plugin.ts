import { code } from "@streamdown/code";
import type { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const THEMES: ["github-light", "github-dark"] = ["github-light", "github-dark"];
// Highlighting tokenizes the whole block on every change to it; past this it stays plain.
const HIGHLIGHT_CHAR_CAP = 20_000;

interface Span {
  from: number;
  to: number;
  style: string;
}

const key = new PluginKey<DecorationSet>("codeHighlight");
const idle = () => undefined;

/** Coloured runs of one code block, offset from its first character; null until its grammar loads. */
const spansOf = (node: Node, refresh: () => void): Span[] | null => {
  const language = node.attrs.language as unknown;
  const text = node.textContent;
  if (
    typeof language !== "string" ||
    text.length > HIGHLIGHT_CHAR_CAP ||
    !code.supportsLanguage(language as never)
  )
    return [];
  const result = code.highlight(
    { code: text, language: language as never, themes: THEMES },
    refresh,
  );
  if (!result) return null;
  const spans: Span[] = [];
  let at = 0;
  for (const line of result.tokens) {
    for (const token of line) {
      const to = at + token.content.length;
      // The light colour plus a --shiki-dark property, which app.css swaps to under .dark.
      const style = Object.entries(token.htmlStyle ?? {})
        .map(([property, value]) => `${property}:${value}`)
        .join(";");
      if (style && to > at) spans.push({ from: at, to, style });
      at = to;
    }
    at += 1;
  }
  return spans;
};

/**
 * Colours code blocks with the transcript's highlighter, as decorations: the
 * document holds only the text. A block unchanged since the last pass keeps
 * its spans, so typing in one block re-tokenizes only that one.
 */
export const codeHighlightPlugin = () => {
  const cache = new WeakMap<Node, Span[]>();
  let refresh: () => void = idle;
  const decorate = (doc: Node) => {
    const decorations: Decoration[] = [];
    doc.descendants((node, position) => {
      if (node.type.name !== "codeBlock") return !node.isTextblock;
      let spans = cache.get(node);
      if (!spans) {
        spans = spansOf(node, () => refresh()) ?? undefined;
        if (spans) cache.set(node, spans);
      }
      for (const span of spans ?? [])
        decorations.push(
          Decoration.inline(position + 1 + span.from, position + 1 + span.to, {
            style: span.style,
            "data-shiki-token": "",
          }),
        );
      return false;
    });
    return DecorationSet.create(doc, decorations);
  };
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_config, state) => decorate(state.doc),
      apply: (tr, previous, _old, state) =>
        tr.docChanged || tr.getMeta(key) ? decorate(state.doc) : previous,
    },
    // A grammar loads once, after which the blocks waiting on it are drawn again.
    view: (view) => {
      refresh = () => {
        if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(key, true));
      };
      return {
        destroy: () => {
          refresh = idle;
        },
      };
    },
    props: { decorations: (state) => key.getState(state) ?? null },
  });
};
