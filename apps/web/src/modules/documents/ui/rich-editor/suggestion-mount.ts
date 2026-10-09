import type { SuggestionProps } from "@tiptap/suggestion";

/** The nearest ancestor that scrolls: its box is where text can be seen. */
const scrollBox = (element: HTMLElement) => {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
};

/**
 * Mounts a suggestion menu at the caret, hidden while the caret is scrolled
 * out of the editor's box. The menu lives on the page, so it would otherwise
 * hang over the panel's header and toolbar.
 */
export const mountAtCaret = (
  props: Pick<SuggestionProps, "editor" | "mount" | "clientRect">,
  element: HTMLElement,
) => {
  const box = scrollBox(props.editor.view.dom);
  // Hidden until placed, so it never flashes at the page's corner.
  Object.assign(element.style, { visibility: "hidden", width: "max-content" });
  return props.mount(element, {
    onPosition: ({ x, y, strategy }) => {
      const caret = props.clientRect?.();
      const bounds = box?.getBoundingClientRect();
      const seen = !caret || !bounds || (caret.bottom > bounds.top && caret.top < bounds.bottom);
      Object.assign(element.style, {
        position: strategy,
        left: `${x}px`,
        top: `${y}px`,
        visibility: seen ? "" : "hidden",
      });
    },
  });
};
