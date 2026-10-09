import { Node } from "@tiptap/core";

export const PENDING_INTENT_CHARS = 200;

/**
 * A section the model has planned and not written yet: it holds only what
 * will go there. The model replaces it with the real content; a person may
 * delete it. It writes no Markdown, so cards, search and Copy never show it.
 */
export const Pending = Node.create({
  name: "pending",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      intent: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-intent") ?? "",
        renderHTML: (attributes) => ({ "data-intent": attributes.intent }),
      },
    };
  },
  parseHTML: () => [{ tag: "div[data-pending]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", { ...HTMLAttributes, "data-pending": "" }],
  renderMarkdown: () => "",
});
