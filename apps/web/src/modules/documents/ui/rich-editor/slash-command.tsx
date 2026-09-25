import {
  CheckListIcon,
  CodeSquareIcon,
  Heading01Icon,
  Heading02Icon,
  Heading03Icon,
  LeftToRightListBulletIcon,
  LeftToRightListNumberIcon,
  MinusSignIcon,
  QuoteDownIcon,
  Table01Icon,
  TextIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type HugeiconsIconProps } from "@hugeicons/react";
import { Extension, type Editor, type Range } from "@tiptap/core";
import { isChangeOrigin } from "@tiptap/extension-collaboration";
import { ReactRenderer } from "@tiptap/react";
import { Suggestion, type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { useImperativeHandle, useState, type Ref } from "react";
import { cn } from "~/ui/utils";

interface SlashItem {
  title: string;
  icon: HugeiconsIconProps["icon"];
  /** Extra words it is found by. */
  keywords: string;
  run: (editor: Editor, range: Range) => void;
}

const blocks = (editor: Editor, range: Range) => editor.chain().focus().deleteRange(range);
export const SLASH_ITEMS: SlashItem[] = [
  {
    title: "Text",

    icon: TextIcon,
    keywords: "paragraph",
    run: (e, r) => blocks(e, r).setParagraph().run(),
  },
  {
    title: "Heading 1",

    icon: Heading01Icon,
    keywords: "h1 title",
    run: (e, r) => blocks(e, r).setHeading({ level: 1 }).run(),
  },
  {
    title: "Heading 2",

    icon: Heading02Icon,
    keywords: "h2 subtitle",
    run: (e, r) => blocks(e, r).setHeading({ level: 2 }).run(),
  },
  {
    title: "Heading 3",

    icon: Heading03Icon,
    keywords: "h3",
    run: (e, r) => blocks(e, r).setHeading({ level: 3 }).run(),
  },
  {
    title: "Bulleted list",

    icon: LeftToRightListBulletIcon,
    keywords: "ul unordered bullet",
    run: (e, r) => blocks(e, r).toggleBulletList().run(),
  },
  {
    title: "Numbered list",

    icon: LeftToRightListNumberIcon,
    keywords: "ol ordered number",
    run: (e, r) => blocks(e, r).toggleOrderedList().run(),
  },
  {
    title: "Checklist",

    icon: CheckListIcon,
    keywords: "todo task checkbox",
    run: (e, r) => blocks(e, r).toggleTaskList().run(),
  },
  {
    title: "Quote",

    icon: QuoteDownIcon,
    keywords: "blockquote citation",
    run: (e, r) => blocks(e, r).toggleBlockquote().run(),
  },
  {
    title: "Code block",

    icon: CodeSquareIcon,
    keywords: "pre snippet",
    run: (e, r) => blocks(e, r).toggleCodeBlock().run(),
  },
  {
    title: "Table",

    icon: Table01Icon,
    keywords: "grid",
    run: (e, r) => blocks(e, r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    title: "Divider",

    icon: MinusSignIcon,
    keywords: "hr rule separator",
    run: (e, r) => blocks(e, r).setHorizontalRule().run(),
  },
];

export const filterSlashItems = (query: string) => {
  const needle = query.trim().toLowerCase();
  return needle
    ? SLASH_ITEMS.filter((item) => `${item.title} ${item.keywords}`.toLowerCase().includes(needle))
    : SLASH_ITEMS;
};

interface MenuHandle {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}

function SlashMenu({
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
      aria-label="Insert block"
      className="bg-popover text-popover-foreground ring-foreground/5 dark:ring-foreground/10 max-h-80 w-56 overflow-y-auto rounded-3xl p-1.5 shadow-lg ring-1"
    >
      {items.length === 0 ? (
        <p className="text-muted-foreground px-3 py-2 text-sm">No matching block</p>
      ) : (
        items.map((item, index) => (
          <button
            key={item.title}
            type="button"
            role="option"
            aria-selected={index === active}
            ref={(element) => {
              if (index === active) element?.scrollIntoView?.({ block: "nearest" });
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
            {item.title}
          </button>
        ))
      )}
    </div>
  );
}

/** Type / to insert a block: the same blocks the toolbar offers, found by name. */
export const SlashCommand = Extension.create({
  name: "slashCommand",
  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        char: "/",
        // A collaborator's typing must never open this person's menu.
        shouldShow: ({ transaction }) => !isChangeOrigin(transaction),
        items: ({ query }) => filterSlashItems(query),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: () => {
          let renderer: ReactRenderer<MenuHandle> | null = null;
          let unmount: (() => void) | null = null;
          return {
            onStart: (props: SuggestionProps<SlashItem, SlashItem>) => {
              renderer = new ReactRenderer(SlashMenu, { props, editor: props.editor });
              unmount = props.mount(renderer.element);
            },
            onUpdate: (props) => renderer?.updateProps(props),
            onKeyDown: (props) => {
              if (props.event.key === "Escape") return false;
              return renderer?.ref?.onKeyDown(props) ?? false;
            },
            onExit: () => {
              unmount?.();
              renderer?.destroy();
              renderer = null;
            },
          };
        },
      }),
    ];
  },
});
