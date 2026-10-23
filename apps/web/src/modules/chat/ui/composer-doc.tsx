import { InputRule, Node, type Editor, type JSONContent } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import type { ReactNode } from "react";
import {
  integrationForName,
  mentionNamePattern,
  type Mentionable,
} from "~/modules/integrations/mentions.ts";
import { splitMessageTags, tagMarkup, type ContextTag } from "../tags.ts";
import { ContextTagNodeView, MentionView } from "./composer-node-views.tsx";

/*
 * The composer edits a document but hands everyone else a string: one paragraph
 * per line, an integration mention as its typed "@Name", a skill or collection
 * as its link (`tags.ts`). The model, the stored message, retry and branch never
 * see the document.
 */

export const MENTION_NODE = "integrationMention";
export const TAG_NODE = "contextTag";

export const contextTagContent = (tag: ContextTag): JSONContent => ({
  type: TAG_NODE,
  attrs: { kind: tag.kind, id: tag.id, name: tag.name },
});

const lineContent = (line: string, integrations: Mentionable): JSONContent[] =>
  splitMessageTags(line, integrations).map((segment) =>
    segment.kind === "integration"
      ? {
          type: MENTION_NODE,
          attrs: { integrationId: segment.integrationId, text: segment.text },
        }
      : segment.kind === "tag"
        ? contextTagContent(segment.tag)
        : { type: "text", text: segment.text },
  );

const paragraph = (line: string, integrations: Mentionable): JSONContent =>
  line ? { type: "paragraph", content: lineContent(line, integrations) } : { type: "paragraph" };

/** `integrations` are the names an "@" may turn into a tag. */
export const textToDoc = (value: string, integrations: Mentionable): JSONContent => ({
  type: "doc",
  content: value.split("\n").map((line) => paragraph(line, integrations)),
});

/** What a paste inserts: inline content for one line, paragraphs for several. */
export const textToSlice = (value: string, integrations: Mentionable): JSONContent[] =>
  value.includes("\n")
    ? value.split("\n").map((line) => paragraph(line, integrations))
    : lineContent(value, integrations);

export const docToText = (editor: Editor) => editor.getText({ blockSeparator: "\n" });

export interface IntegrationMentionOptions {
  /** A mention typed out in full rather than picked: turn it on like picking it. */
  onTyped: (integrationId: string) => void;
  /** The names a typed "@" may complete, read when the rule runs. */
  integrations: () => Mentionable;
  /** A mark of the source's own instead of a service's logo; null for the logo. */
  icon: (id: string) => ReactNode;
}

/**
 * An `@Name` integration mention. An atom, so the caret steps over it and
 * nothing edits inside it; its text is exactly what was typed, so the string
 * the composer hands out is unchanged by showing it as a tag.
 */
export const IntegrationMention = Node.create<IntegrationMentionOptions>({
  name: MENTION_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,

  addOptions() {
    return { onTyped: () => undefined, integrations: () => [], icon: () => null };
  },

  addAttributes() {
    return { integrationId: { default: "" }, text: { default: "" } };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-integration-mention]",
        getAttrs: (element) => ({
          integrationId: element.getAttribute("data-integration-mention"),
          text: element.textContent,
        }),
      },
    ];
  },

  renderHTML({ node }) {
    return ["span", { "data-integration-mention": node.attrs.integrationId }, node.attrs.text];
  },

  renderText({ node }) {
    return node.attrs.text as string;
  },

  addNodeView() {
    return ReactNodeViewRenderer(MentionView, { as: "span" });
  },

  addInputRules() {
    return [
      new InputRule({
        // Runs as the space after the name is typed, before it is inserted.
        // The names are the integrations offered now, so the pattern is built per run.
        find: (text) => {
          const names = mentionNamePattern(this.options.integrations());
          if (!names) return null;
          const found = new RegExp(String.raw`(?:^|\s)(@(${names}))\s$`, "iu").exec(text);
          return found
            ? { index: found.index, text: found[0], data: { mention: found[1], name: found[2] } }
            : null;
        },
        handler: ({ state, range, match }) => {
          const { mention, name } = match.data as { mention: string; name: string };
          const integration = integrationForName(name, this.options.integrations());
          if (!integration) return null;
          // From the match's own "@": whether the range ends before or after the
          // typed space differs between Tiptap versions, so its end cannot place it.
          const from = range.from + match[0].indexOf(mention);
          state.tr.replaceWith(from, range.to, [
            this.type.create({ integrationId: integration.id, text: mention }),
            state.schema.text(" "),
          ]);
          this.options.onTyped(integration.id);
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    return wholeTagKeys(this.editor, this.type.name);
  },
});

/** One key removes a whole tag, whichever side of it the caret is on. */
function wholeTagKeys(editor: Editor, type: string) {
  const remove = (side: "before" | "after") => () => {
    const { selection } = editor.state;
    if (!selection.empty) return false;
    const node = side === "before" ? selection.$from.nodeBefore : selection.$from.nodeAfter;
    if (node?.type.name !== type) return false;
    const from = side === "before" ? selection.from - node.nodeSize : selection.from;
    return editor.commands.deleteRange({ from, to: from + node.nodeSize });
  };
  return { Backspace: remove("before"), Delete: remove("after") };
}

/**
 * A /skill or #collection picked into the text. An atom like the integration
 * mention; its text is the link the stored message keeps (`tags.ts`).
 */
export const ContextTagNode = Node.create({
  name: TAG_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    return { kind: { default: "skill" }, id: { default: "" }, name: { default: "" } };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-context-tag]",
        getAttrs: (element) => ({
          kind: element.getAttribute("data-context-tag"),
          id: element.getAttribute("data-id"),
          name: element.getAttribute("data-name"),
        }),
      },
    ];
  },

  renderHTML({ node }) {
    return [
      "span",
      {
        "data-context-tag": node.attrs.kind,
        "data-id": node.attrs.id,
        "data-name": node.attrs.name,
      },
      node.attrs.name,
    ];
  },

  renderText({ node }) {
    return tagMarkup(node.attrs as ContextTag);
  },

  addNodeView() {
    return ReactNodeViewRenderer(ContextTagNodeView, { as: "span" });
  },

  addKeyboardShortcuts() {
    return wholeTagKeys(this.editor, this.type.name);
  },
});
