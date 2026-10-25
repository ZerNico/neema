import { m } from "~/paraglide/messages.js";
import { HugeiconsIcon, type HugeiconsIconProps } from "@hugeicons/react";
import type { Editor, Range } from "@tiptap/core";
import type { SuggestionKeyDownProps } from "@tiptap/suggestion";
import { useImperativeHandle, useState, type Ref } from "react";
import { cn } from "~/ui/utils";

export interface SlashItem {
  /** Its name, read where it is shown. */
  title: () => string;
  icon: HugeiconsIconProps["icon"];
  /** Extra words it is found by. */
  keywords: string;
  run: (editor: Editor, range: Range) => void;
  /** Offered only where this holds; always when absent. */
  available?: (editor: Editor) => boolean;
}

export interface MenuHandle {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}

/**
 * Scrolls only the menu's own list to the item. `scrollIntoView` would also
 * scroll the document panel the menu sits in, away from the caret.
 */
const revealInList = (item: HTMLElement) => {
  const list = item.parentElement;
  if (!list) return;
  const at = item.getBoundingClientRect();
  const frame = list.getBoundingClientRect();
  if (at.top < frame.top) list.scrollTop -= frame.top - at.top;
  else if (at.bottom > frame.bottom) list.scrollTop += at.bottom - frame.bottom;
};

export function SlashMenu({
  items,
  command,
  ref,
}: {
  items: SlashItem[];
  command: (item: SlashItem) => void;
  ref?: Ref<MenuHandle>;
}) {
  const [active, setActive] = useState(0);
  const [seen, setSeen] = useState(items);
  // A new query starts from the first match again.
  if (seen !== items) {
    setSeen(items);
    setActive(0);
  }
  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (!items.length) return false;
      if (event.key === "ArrowDown") {
        setActive((index) => (index + 1) % items.length);
        return true;
      }
      if (event.key === "ArrowUp") {
        setActive((index) => (index - 1 + items.length) % items.length);
        return true;
      }
      if (event.key === "Enter") {
        command(items[active]!);
        return true;
      }
      return false;
    },
  }));
  return (
    // The same surface and items as the app's dropdown menus.
    <div
      role="listbox"
      aria-label={m.documents_slash_label()}
      className="bg-popover text-popover-foreground ring-foreground/5 dark:ring-foreground/10 max-h-80 w-56 overflow-y-auto rounded-3xl p-1.5 shadow-lg ring-1"
    >
      {items.length === 0 ? (
        <p className="text-muted-foreground px-3 py-2 text-sm">{m.documents_slash_empty()}</p>
      ) : (
        items.map((item, index) => (
          <button
            key={item.title()}
            type="button"
            role="option"
            aria-selected={index === active}
            ref={(element) => {
              if (index === active && element) revealInList(element);
            }}
            className={cn(
              "flex w-full cursor-default items-center gap-2.5 rounded-2xl px-3 py-2 text-left text-sm font-medium outline-hidden select-none",
              index === active && "bg-accent text-accent-foreground",
            )}
            onMouseEnter={() => setActive(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => command(item)}
          >
            <HugeiconsIcon
              icon={item.icon}
              strokeWidth={2}
              className="text-muted-foreground size-4"
            />
            {item.title()}
          </button>
        ))
      )}
    </div>
  );
}
