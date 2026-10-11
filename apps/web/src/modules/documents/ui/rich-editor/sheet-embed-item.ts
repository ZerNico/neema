import { ReactNodeViewRenderer } from "@tiptap/react";
import { SheetEmbed } from "../../editor/sheet-embed.ts";
import { SheetEmbedView } from "./sheet-embed-view.tsx";

/** The shared embed node, drawn live in the browser; the schema is unchanged. */
export const BrowserSheetEmbed = SheetEmbed.extend({
  addNodeView: () => ReactNodeViewRenderer(SheetEmbedView),
});
