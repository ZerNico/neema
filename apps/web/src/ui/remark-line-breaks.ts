/** The part of an mdast node this plugin reads; the full types are not a dependency. */
interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
}

const splitLines = (node: MarkdownNode) => {
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    if (child.type !== "text" || !child.value?.includes("\n")) {
      splitLines(child);
      return [child];
    }
    const pieces: MarkdownNode[] = [];
    for (const [index, line] of child.value.split("\n").entries()) {
      if (index > 0) pieces.push({ type: "break" });
      if (line) pieces.push({ type: "text", value: line });
    }
    return pieces;
  });
};

/**
 * Every line break in running text becomes a visible one. Markdown folds a
 * single break into a space, which is right for a model's prose and wrong for
 * a document people type into: Enter should start a new line. Code is its own
 * node type, so fences and inline code keep their text untouched.
 */
export const remarkLineBreaks = () => splitLines;
