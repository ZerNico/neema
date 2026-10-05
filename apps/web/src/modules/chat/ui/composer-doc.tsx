import { InputRule, Node, type Editor, type JSONContent } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { integrationForName, integrationNamePattern } from "~/modules/integrations/mentions.ts";
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

const lineContent = (line: string): JSONContent[] =>
  splitMessageTags(line).map((segment) =>
    segment.kind === "integration"
      ? {
          type: MENTION_NODE,
          attrs: { integrationId: segment.integrationId, text: segment.text },
        }
      : segment.kind === "tag"
        ? contextTagContent(segment.tag)
        : { type: "text", text: segment.text },
  );

const paragraph = (line: string): JSONContent =>
  line ? { type: "paragraph", content: lineContent(line) } : { type: "paragraph" };

export const textToDoc = (value: string): JSONContent => ({
  type: "doc",
  content: value.split("\n").map(paragraph),
});

/** What a paste inserts: inline content for one line, paragraphs for several. */
export const textToSlice = (value: string): JSONContent[] =>
  value.includes("\n") ? value.split("\n").map(paragraph) : lineContent(value);

export const docToText = (editor: Editor) => editor.getText({ blockSeparator: "\n" });

export interface IntegrationMentionOptions {
  /** A mention typed out in full rather than picked: turn it on like picking it. */
  onTyped: (integrationId: string) => void;
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
    return { onTyped: () => undefined };
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
        find: new RegExp(String.raw`(?:^|\s)(@(${integrationNamePattern}))\s$`, "iu"),
        handler: ({ state, range, match }) => {
          const integration = integrationForName(match[2]!);
          if (!integration) return null;
          const from = range.to - match[1]!.length;
          state.tr.replaceWith(from, range.to, [
            this.type.create({ integrationId: integration.id, text: match[1] }),
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
