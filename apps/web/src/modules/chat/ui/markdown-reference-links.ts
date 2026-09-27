import { isFileReferenceHref } from "../file-references.ts";

interface MarkdownNode {
  type: string;
  tagName?: string;
  properties?: { href?: unknown };
  data?: Record<string, unknown>;
  children?: MarkdownNode[];
}

/** Leave ordinary anchors to Streamdown, including its link-safety dialog. */
export function markdownReferenceLinks({ citations = false } = {}) {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      const href = node.properties?.href;
      if (
        node.type === "element" &&
        node.tagName === "a" &&
        typeof href === "string" &&
        (isFileReferenceHref(href) || (citations && href.startsWith("#user-content-fn-")))
      ) {
        node.tagName = "span";
        node.data = { ...node.data, referenceHref: href };
        delete node.properties!.href;
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
  };
}
