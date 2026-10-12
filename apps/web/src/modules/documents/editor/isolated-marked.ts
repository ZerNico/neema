import { Marked, type marked } from "marked";
import { DocumentLexer } from "./block-start.ts";

/** Whether a marked has what a Markdown manager uses of it: tokenizer extensions and a lexer. */
const usable = (value: Marked): value is Marked & typeof marked =>
  typeof value.use === "function" && typeof value.Lexer === "function";

/**
 * A marked of its own for one Markdown manager. Managers otherwise share the
 * global one, so another editor's tokenizers (upstream's `++` underline) would
 * change how documents read. The option is typed as the global function; the
 * manager uses only what an instance has too.
 */
export const isolatedMarked = () => {
  const instance = new Marked();
  instance.Lexer = DocumentLexer;
  if (!usable(instance)) throw new Error("marked no longer has use() and Lexer");
  return instance;
};
