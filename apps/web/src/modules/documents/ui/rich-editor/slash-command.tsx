import {
  AiChat02Icon,
  Calendar03Icon,
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
  UserIcon,
} from "@hugeicons/core-free-icons";
import { Extension, type Editor, type Range } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import { Suggestion, type SuggestionProps } from "@tiptap/suggestion";
import { isRemoteChange } from "../../editor/remote.ts";
import { isoDay } from "./dates.ts";
import { editorHooks } from "./editor-hooks.ts";
import { SlashMenu, type MenuHandle, type SlashItem } from "./slash-menu.tsx";

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
  {
    title: "Date",
    icon: Calendar03Icon,
    keywords: "today day calendar",
    run: (e, r) =>
      blocks(e, r)
        .insertContent([
          { type: "dateChip", attrs: { value: isoDay(new Date()) } },
          { type: "text", text: " " },
        ])
        .run(),
  },
  {
    title: "Mention someone",
    icon: UserIcon,
    keywords: "person people @",
    run: (e, r) => blocks(e, r).insertContent("@").run(),
  },
  {
    title: "Ask the assistant",
    icon: AiChat02Icon,
    keywords: "ai write generate help",
    available: (editor) => editorHooks(editor).ask !== null,
    // A planned section with no request yet: the ask input opens on it.
    run: (e, r) =>
      blocks(e, r)
        .command(({ tr, state }) => {
          const { $from } = tr.selection;
          const pending = state.schema.nodes.pending!.create({ intent: "" });
          const empty = $from.depth === 1 && $from.parent.content.size === 0;
          const at = empty ? $from.before(1) : $from.after(1);
          if (empty) tr.replaceWith(at, $from.after(1), pending);
          else tr.insert(at, pending);
          tr.setSelection(NodeSelection.create(tr.doc, at));
          return true;
        })
        .run(),
  },
];

/** How well an item answers the query: its name first, then words in it, then keywords. */
const rank = (item: SlashItem, needle: string) => {
  const title = item.title.toLowerCase();
  if (title.startsWith(needle)) return 0;
  if (title.split(" ").some((word) => word.startsWith(needle))) return 1;
  if (title.includes(needle)) return 2;
  return item.keywords.toLowerCase().includes(needle) ? 3 : null;
};

export const filterSlashItems = (query: string) => {
  const needle = query.trim().toLowerCase();
  if (!needle) return SLASH_ITEMS;
  return SLASH_ITEMS.flatMap((item) => {
    const score = rank(item, needle);
    return score === null ? [] : [{ item, score }];
  })
    .toSorted((a, b) => a.score - b.score)
    .map(({ item }) => item);
};

/** Type / to insert a block: the same blocks the toolbar offers, found by name. */
export const SlashCommand = Extension.create({
  name: "slashCommand",
  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        char: "/",
        // A collaborator's typing must never open this person's menu.
        shouldShow: ({ transaction }) => !isRemoteChange(transaction),
        items: ({ query, editor }) =>
          filterSlashItems(query).filter((item) => !item.available || item.available(editor)),
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
