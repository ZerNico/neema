import { InputRule, Node, type Editor, type JSONContent } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import {
  integrationForName,
  integrationNamePattern,
  splitIntegrationMentions,
} from "~/modules/integrations/mentions.ts";
import { IntegrationTag } from "~/modules/integrations/ui/integration-mention-text.tsx";

/*
 * The composer edits a document but hands everyone else a string: one paragraph
 * per line, an integration mention as its typed "@Name". The model, the stored
 * message, retry and branch never see the document.
 */

export const MENTION_NODE = "integrationMention";

const lineContent = (line: string): JSONContent[] =>
  splitIntegrationMentions(line).map((segment) =>
    segment.kind === "mention"
      ? {
          type: MENTION_NODE,
          attrs: { integrationId: segment.integrationId, text: segment.text },
        }
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

function MentionView({ node }: NodeViewProps) {
  return (
    <NodeViewWrapper as="span" contentEditable={false}>
      <IntegrationTag
        integrationId={node.attrs.integrationId as string}
        fallback={node.attrs.text as string}
        tone="field"
      />
    </NodeViewWrapper>
  );
}

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
    // One key removes the whole tag, whichever side the caret is on.
    const remove = (side: "before" | "after") => () => {
      const { selection } = this.editor.state;
      if (!selection.empty) return false;
      const node = side === "before" ? selection.$from.nodeBefore : selection.$from.nodeAfter;
      if (node?.type !== this.type) return false;
      const from = side === "before" ? selection.from - node.nodeSize : selection.from;
      return this.editor.commands.deleteRange({ from, to: from + node.nodeSize });
    };
    return { Backspace: remove("before"), Delete: remove("after") };
  },
});
