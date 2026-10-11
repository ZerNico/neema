import { ReactNodeViewRenderer } from "@tiptap/react";
import { Pending } from "../../editor/pending.ts";
import { PendingView } from "./pending-view.tsx";

/** The shared node, drawn in the browser; the schema is unchanged. */
export const DocumentPending = Pending.extend({
  addNodeView: () => ReactNodeViewRenderer(PendingView),
});
