import { Extension } from "@tiptap/core";
import { Book02Icon, FolderLibraryIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { IntegrationLogo } from "~/modules/integrations/ui/integration-logo.tsx";
import { Placeholder } from "@tiptap/extensions";
import { Fragment, Slice } from "@tiptap/pm/model";
import { PluginKey, TextSelection } from "@tiptap/pm/state";
import { EditorContent, useEditor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { Suggestion, exitSuggestion } from "@tiptap/suggestion";
import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type ReactNode,
  type SetStateAction,
} from "react";
import { MentionList, type MentionItem } from "~/ui/mention-list.tsx";
import { filterMentionItems } from "~/ui/filter-mention-items.ts";
import { cn } from "~/ui/utils";
import type { ContextTag } from "../tags.ts";
import {
  ContextTagNode,
  IntegrationMention,
  MENTION_NODE,
  TAG_NODE,
  contextTagContent,
  docToText,
  textToDoc,
  textToSlice,
} from "./composer-doc.tsx";

/** The "@" rows as names a typed mention may complete. */
const mentionable = (source: TextareaMentions | undefined) =>
  (source?.items ?? []).map((item) => ({ id: item.id, name: item.label }));

/** Offerable rows plus what to do with the one that is picked. */
export interface TextareaMentions {
  items: readonly MentionItem[];
  onSelect: (id: string) => void;
  /** The mark beside a name, in the list and its tag; a connected service's logo when absent. */
  icon?: ((id: string) => ReactNode) | undefined;
}

/** What callers hold instead of a DOM element: the field is a document editor. */
export interface ComposerFieldHandle {
  focus: (options?: { preventScroll?: boolean; atEnd?: boolean }) => void;
  /** The draft as the string everyone else sees. */
  value: () => string;
  /** Puts tags at the caret without taking focus: a pick made outside the text. */
  insertTags: (tags: readonly ContextTag[]) => void;
  /** Takes out every tag of these ids: a deselection made outside the text. */
  removeTags: (kind: ContextTag["kind"], ids: ReadonlySet<string>) => void;
}

type Trigger = "/" | "#" | "@";
const TRIGGERS: readonly Trigger[] = ["/", "#", "@"];
const TRIGGER_LABEL: Record<Trigger, string> = {
  "/": "Local skills",
  "#": "Knowledge collections",
  "@": "Integrations",
};
const suggestionKeys: Record<Trigger, PluginKey> = {
  "/": new PluginKey("composer-mention-/"),
  "#": new PluginKey("composer-mention-#"),
  "@": new PluginKey("composer-mention-@"),
};

/** A list row leads with the mark its tag will carry. */
const LIST_ICON: Record<Trigger, (item: MentionItem) => ReactNode> = {
  "/": () => <HugeiconsIcon icon={Book02Icon} strokeWidth={2} className="size-4" />,
  "#": () => <HugeiconsIcon icon={FolderLibraryIcon} strokeWidth={2} className="size-4" />,
  "@": (item) => <IntegrationLogo integrationId={item.id} className="size-4" />,
};

interface OpenList {
  trigger: Trigger;
  query: string;
  items: MentionItem[];
  caretRect: (() => DOMRect | null) | null;
  command: (item: MentionItem) => void;
}

/** Everything the once-built editor calls back into, read fresh on each call. */
interface Latest {
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: (() => void) | undefined;
  onPasteData: ((data: DataTransfer) => boolean) | undefined;
  placeholder: string | undefined;
  sources: Record<Trigger, TextareaMentions | undefined>;
  list: OpenList | null;
  active: number;
}

/**
 * The `/`, `#` and `@` lists. One suggestion plugin per trigger; each only
 * matches at the start of a word and only while its source is offered.
 * Accepting `/` or `#` removes the typed token and hands the id back; `@`
 * leaves a tag in the text. Higher priority than ComposerKeys, so an open
 * list gets Enter and Escape first.
 */
const mentionSuggestions = (
  latest: RefObject<Latest>,
  setList: Dispatch<SetStateAction<OpenList | null>>,
  setActive: Dispatch<SetStateAction<number>>,
) =>
  Extension.create({
    name: "composerMentions",
    priority: 200,
    addProseMirrorPlugins() {
      return TRIGGERS.map((trigger) => {
        const show = (props: {
          query: string;
          items: MentionItem[];
          clientRect?: (() => DOMRect | null) | null;
          command: (item: MentionItem) => void;
        }) => {
          setList((current) => {
            // A new query starts from the first match again.
            if (current?.trigger !== trigger || current.query !== props.query) setActive(0);
            return {
              trigger,
              query: props.query,
              items: props.items,
              caretRect: props.clientRect ?? null,
              command: props.command,
            };
          });
        };
        return Suggestion<MentionItem, MentionItem>({
          editor: this.editor,
          pluginKey: suggestionKeys[trigger],
          char: trigger,
          allow: () => !!latest.current.sources[trigger],
          items: ({ query }) => {
            const source = latest.current.sources[trigger];
            return source ? filterMentionItems(source.items, query) : [];
          },
          command: ({ editor, range, props: item }) => {
            const source = latest.current.sources[trigger];
            if (!source) return;
            // A tag replaces the typed token, with a space after it unless the
            // text already has one there; either way the caret lands past it.
            const next = editor.state.doc.textBetween(
              range.to,
              Math.min(range.to + 1, editor.state.doc.content.size),
            );
            editor
              .chain()
              .focus()
              .insertContentAt(range, [
                trigger === "@"
                  ? {
                      type: MENTION_NODE,
                      attrs: { integrationId: item.id, text: `@${item.label}` },
                    }
                  : contextTagContent({
                      kind: trigger === "/" ? "skill" : "collection",
                      id: item.id,
                      name: item.label,
                    }),
                ...(next === " " ? [] : [{ type: "text", text: " " }]),
              ])
              .command(({ tr }) => {
                if (next === " ")
                  tr.setSelection(TextSelection.create(tr.doc, tr.selection.from + 1));
                return true;
              })
              .run();
            source.onSelect(item.id);
          },
          render: () => {
            return {
              onStart: show,
              onUpdate: show,
              onKeyDown: ({ event, view }) => {
                const { list, active } = latest.current;
                if (
                  !list?.items.length ||
                  event.isComposing ||
                  event.shiftKey ||
                  event.altKey ||
                  event.ctrlKey ||
                  event.metaKey
                )
                  return false;
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  const step = event.key === "ArrowDown" ? 1 : list.items.length - 1;
                  setActive((active + step) % list.items.length);
                  return true;
                }
                if (event.key === "Enter") {
                  list.command(list.items[Math.min(active, list.items.length - 1)]!);
                  return true;
                }
                if (event.key === "Escape") {
                  exitSuggestion(view, suggestionKeys[trigger]);
                  return true;
                }
                return false;
              },
              onExit: () => setList((current) => (current?.trigger === trigger ? null : current)),
            };
          },
        });
      });
    },
  });

/**
 * Enter sends, Shift+Enter starts a new line, Escape cancels an edit. None of
 * them act on a key that confirms or cancels an IME composition; ProseMirror's
 * keymap does not skip those itself.
 */
const composerKeys = (composing: RefObject<boolean>, latest: RefObject<Latest>) =>
  Extension.create({
    name: "composerKeys",
    addKeyboardShortcuts() {
      return {
        Enter: () => {
          if (composing.current || this.editor.view.composing) return false;
          latest.current.onSubmit();
          return true;
        },
        "Shift-Enter": () => this.editor.commands.splitBlock(),
        Escape: () => {
          const cancel = latest.current.onCancel;
          if (!cancel || composing.current || this.editor.view.composing) return false;
          cancel();
          return true;
        },
      };
    },
  });

export const ChatTextarea = forwardRef<
  ComposerFieldHandle,
  {
    value: string;
    onValueChange: (value: string) => void;
    onSubmit: () => void;
    onCancel?: (() => void) | undefined;
    placeholder?: string;
    ariaLabel?: string;
    autoFocus?: boolean;
    disabled?: boolean;
    className?: string;
    /** Typed as `/name`. */
    skills?: TextareaMentions | undefined;
    /** Typed as `#name`. */
    collections?: TextareaMentions | undefined;
    /** Typed as `@name`: turns a connected service on and stays in the text as a tag. */
    integrations?: TextareaMentions | undefined;
    /** Offered a paste first; true when it took it (files, or text too long for a draft). */
    onPasteData?: ((data: DataTransfer) => boolean) | undefined;
  }
>(function ChatTextarea(
  {
    value,
    onValueChange,
    onSubmit,
    onCancel,
    placeholder,
    ariaLabel,
    autoFocus = false,
    disabled = false,
    className,
    skills,
    collections,
    integrations,
    onPasteData,
  },
  forwardedRef,
) {
  const listId = useId();
  const [list, setList] = useState<OpenList | null>(null);
  const [active, setActive] = useState(0);
  const sources = { "/": skills, "#": collections, "@": integrations };
  const latest = useRef<Latest>({
    onValueChange,
    onSubmit,
    onCancel,
    onPasteData,
    placeholder,
    sources,
    list,
    active,
  });
  // Callbacks run after commit, so refreshing here is always in time for them.
  useLayoutEffect(() => {
    latest.current = {
      onValueChange,
      onSubmit,
      onCancel,
      onPasteData,
      placeholder,
      sources,
      list,
      active,
    };
  });
  // Set from each keydown before any keymap sees it; see composerKeys.
  const composing = useRef(false);
  // The last string this field handed out, so the value coming back down as a
  // prop is not mistaken for an outside change and reset under the caret.
  const emitted = useRef(value);

  // Built once. The extensions keep these refs and read them only from editor
  // callbacks, never while rendering.
  // oxlint-disable-next-line react/refs
  const [extensions] = useState(() => [
    StarterKit.configure({
      blockquote: false,
      bold: false,
      bulletList: false,
      code: false,
      codeBlock: false,
      dropcursor: false,
      gapcursor: false,
      hardBreak: false,
      heading: false,
      horizontalRule: false,
      italic: false,
      listItem: false,
      listKeymap: false,
      link: false,
      orderedList: false,
      strike: false,
      underline: false,
      trailingNode: false,
    }),
    Placeholder.configure({ placeholder: () => latest.current.placeholder ?? "" }),
    ContextTagNode,
    IntegrationMention.configure({
      integrations: () => mentionable(latest.current.sources["@"]),
      icon: (id) => latest.current.sources["@"]?.icon?.(id) ?? null,
      // A typed-out mention is the same keyboard route as picking it.
      onTyped: (integrationId) => {
        const source = latest.current.sources["@"];
        if (source?.items.some((item) => item.id === integrationId))
          queueMicrotask(() => source.onSelect(integrationId));
      },
    }),
    mentionSuggestions(latest, setList, setActive),
    composerKeys(composing, latest),
  ]);

  const editor = useEditor({
    extensions,
    content: textToDoc(value, mentionable(integrations)),
    autofocus: autoFocus ? "end" : false,
    editable: !disabled,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
        class: cn(
          "composer-editor block max-h-52 w-full overflow-y-auto px-4 pt-3.5 pb-1 text-sm leading-6 outline-none",
          className,
        ),
      },
      handleKeyDown: (_view, event) => {
        composing.current = event.isComposing || event.keyCode === 229;
        return false;
      },
      handlePaste: (view, event) => {
        const data = event.clipboardData;
        if (!data) return false;
        if (latest.current.onPasteData?.(data)) return true;
        const text = data.getData("text/plain");
        if (!text) return false;
        // Plain words only: formatting has nowhere to go in a message, and an
        // "@Name" in the pasted text becomes a tag as typed text does.
        const content = Fragment.fromJSON(
          view.state.schema,
          textToSlice(text, mentionable(latest.current.sources["@"])),
        );
        // Several lines arrive as paragraphs whose ends join the current one.
        const open = text.includes("\n") ? 1 : 0;
        view.dispatch(view.state.tr.replaceSelection(new Slice(content, open, open)));
        return true;
      },
      // Files dropped on the text belong to the composer's drop zone around it.
      handleDrop: (_view, event) => (event.dataTransfer?.files.length ?? 0) > 0,
    },
    onUpdate: ({ editor: current }) => {
      const text = docToText(current);
      emitted.current = text;
      latest.current.onValueChange(text);
    },
  });

  // An outside change (sent, seeded, a queued message opened for editing)
  // replaces the document. It is not an edit, so it stays out of undo.
  // oxlint-disable-next-line react/exhaustive-effect-dependencies -- emitted is a ref
  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed || value === emitted.current) return;
    emitted.current = value;
    editor
      .chain()
      .setMeta("addToHistory", false)
      .setContent(textToDoc(value, mentionable(latest.current.sources["@"])), {
        emitUpdate: false,
      })
      .command(({ tr }) => {
        tr.setSelection(TextSelection.atEnd(tr.doc));
        return true;
      })
      .run();
  }, [editor, value]);

  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.setEditable(!disabled, false);
  }, [editor, disabled]);

  // The placeholder is a decoration, redrawn only by a transaction; the prop
  // is the trigger, read through `latest` by the extension.
  // oxlint-disable react/exhaustive-effect-dependencies
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr);
  }, [editor, placeholder]);
  // oxlint-enable react/exhaustive-effect-dependencies

  // The open list is announced on the field, which keeps the focus throughout.
  const open = !!list && list.items.length > 0;
  const selectedIndex = list ? Math.min(active, Math.max(0, list.items.length - 1)) : 0;
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const element = editor.view.dom;
    const attributes = {
      "aria-autocomplete": open ? "list" : null,
      "aria-controls": open ? `${listId}-list` : null,
      "aria-activedescendant": open ? `${listId}-${selectedIndex}` : null,
    };
    for (const [name, attribute] of Object.entries(attributes))
      if (attribute === null) element.removeAttribute(name);
      else element.setAttribute(name, attribute);
  }, [editor, open, selectedIndex, listId]);

  useImperativeHandle(
    forwardedRef,
    () => ({
      focus: (options) => {
        const run = () => {
          if (!editor || editor.isDestroyed) return;
          editor.commands.focus(options?.atEnd ? "end" : null, {
            scrollIntoView: !options?.preventScroll,
          });
        };
        // A caller's layout effect can run before the view is attached.
        if (editor?.view.dom.isConnected) run();
        else requestAnimationFrame(run);
      },
      value: () => (editor && !editor.isDestroyed ? docToText(editor) : emitted.current),
      insertTags: (tags) => {
        if (!editor || editor.isDestroyed || tags.length === 0) return;
        const at = editor.state.selection.to;
        const before = at > 1 ? editor.state.doc.textBetween(at - 1, at) : "";
        editor
          .chain()
          .insertContentAt(at, [
            ...(before && before !== " " ? [{ type: "text", text: " " }] : []),
            ...tags.flatMap((tag) => [contextTagContent(tag), { type: "text", text: " " }]),
          ])
          .run();
      },
      removeTags: (kind, ids) => {
        if (!editor || editor.isDestroyed || ids.size === 0) return;
        const ranges: { from: number; to: number }[] = [];
        const { doc } = editor.state;
        doc.descendants((node, position) => {
          if (node.type.name !== TAG_NODE || node.attrs.kind !== kind || !ids.has(node.attrs.id))
            return;
          // The space a pick added after the tag goes with it.
          const end = position + node.nodeSize;
          const space = end < doc.content.size && doc.textBetween(end, end + 1) === " ";
          ranges.push({ from: position, to: space ? end + 1 : end });
        });
        if (ranges.length === 0) return;
        // Last first, so the earlier positions still hold.
        editor
          .chain()
          .command(({ tr }) => {
            for (const range of ranges.toReversed()) tr.delete(range.from, range.to);
            return true;
          })
          .run();
      },
    }),
    [editor],
  );

  return (
    <>
      <EditorContent editor={editor} className={cn(disabled && "opacity-60")} />
      {list ? (
        <MentionList
          id={listId}
          label={TRIGGER_LABEL[list.trigger]}
          items={list.items}
          selectedIndex={selectedIndex}
          caretRect={list.caretRect}
          iconFor={
            list.trigger === "@" && sources["@"]?.icon
              ? (item: MentionItem) => sources["@"]!.icon!(item.id)
              : LIST_ICON[list.trigger]
          }
          onHover={setActive}
          onPick={(index) => {
            const item = list.items[index];
            if (item) list.command(item);
          }}
          onDismiss={() => {
            if (editor && !editor.isDestroyed)
              exitSuggestion(editor.view, suggestionKeys[list.trigger]);
          }}
        />
      ) : null}
    </>
  );
});
