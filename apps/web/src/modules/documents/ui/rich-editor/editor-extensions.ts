import type { EditorOptions } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { Placeholder } from "@tiptap/extensions";
import { DocumentCodeBlock, documentExtensions } from "../../editor/extensions.ts";
import { SizeCap } from "./size-cap.ts";
import { SlashCommand } from "./slash-command.tsx";
import { DocumentDateChip, DocumentMention } from "./chip-items.tsx";
import { DocumentPending } from "./pending-item.tsx";
import { CodeBlockView } from "./code-block-view.tsx";
import { DocumentTaskItem } from "./task-item.tsx";
import { BrowserBlockMath, BrowserInlineMath } from "./math-item.ts";
import { openLink } from "./links.ts";

/**
 * The browser's editor: the shared schema, with tasks drawn by the app's
 * checkbox, Mermaid blocks as diagrams, formulas through KaTeX and planned sections as placeholders (rendering only, the schema is
 * unchanged), the `/` menu and the size cap. The connection adds collaboration and other people's cursors.
 */
export const browserEditorExtensions = [
  ...documentExtensions.map(
    (extension) =>
      ({
        taskItem: DocumentTaskItem,
        pending: DocumentPending,
        dateChip: DocumentDateChip,
        mention: DocumentMention,
        inlineMath: BrowserInlineMath,
        blockMath: BrowserBlockMath,
        codeBlock: DocumentCodeBlock.extend({
          addNodeView: () => ReactNodeViewRenderer(CodeBlockView),
        }),
      })[extension.name] ?? extension,
  ),
  Placeholder.configure({ placeholder: "Write, or type / for blocks" }),
  SlashCommand,
  SizeCap,
];

/** How the editable surface presents itself; links open only on a modified click while editing. */
export const browserEditorProps: EditorOptions["editorProps"] = {
  handleClick: (view, _position, event) => openLink(view.editable, event),
  attributes: {
    class: "rich-editor",
    role: "textbox",
    "aria-multiline": "true",
    "aria-label": "Document",
    spellcheck: "true",
  },
};
