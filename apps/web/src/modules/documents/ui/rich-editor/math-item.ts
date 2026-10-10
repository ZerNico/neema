import { ReactNodeViewRenderer } from "@tiptap/react";
import { DocumentBlockMath, DocumentInlineMath } from "../../editor/math.ts";
import { MathView } from "./math-view.tsx";

/** The shared math nodes, drawn in the browser; the schema is unchanged. */
export const BrowserInlineMath = DocumentInlineMath.extend({
  addNodeView: () => ReactNodeViewRenderer(MathView, { as: "span" }),
});
export const BrowserBlockMath = DocumentBlockMath.extend({
  addNodeView: () => ReactNodeViewRenderer(MathView),
});
