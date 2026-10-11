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
import { BrowserDetails, BrowserFootnote } from "./block-items.ts";
import { BrowserSheetEmbed } from "./sheet-embed-item.ts";
import { DocumentFind } from "./find.ts";
import { ImageUpload } from "./image-upload.ts";
import { openLink } from "./links.ts";

/**
 * The browser's editor: the shared schema, with tasks drawn by the app's
 * checkbox, Mermaid blocks as diagrams, formulas through KaTeX, sheet embeds drawn live and planned sections as placeholders (rendering only, the schema is
 * unchanged), the `/` menu, find, image uploads and the size cap. The connection adds collaboration and other people's cursors.
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
        details: BrowserDetails,
        footnote: BrowserFootnote,
        blockMath: BrowserBlockMath,
        sheetEmbed: BrowserSheetEmbed,
        codeBlock: DocumentCodeBlock.extend({
          addNodeView: () => ReactNodeViewRenderer(CodeBlockView),
        }),
      })[extension.name] ?? extension,
  ),
  Placeholder.configure({
    // An empty document invites writing; an empty section title names what goes there.
    placeholder: ({ node }) =>
      node.type.name === "detailsSummary" ? "Section title" : "Write, or type / for blocks",
    includeChildren: true,
  }),
  SlashCommand,
  DocumentFind,
  ImageUpload,
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
