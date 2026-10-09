import { UserIcon } from "@hugeicons/core-free-icons";
import { ReactNodeViewRenderer, ReactRenderer } from "@tiptap/react";
import type { SuggestionProps } from "@tiptap/suggestion";
import { DateChip, PersonMention } from "../../editor/chips.ts";
import { isRemoteChange } from "../../editor/remote.ts";
import { DateChipView } from "./date-chip-view.tsx";
import { editorHooks, type MentionCandidate } from "./editor-hooks.ts";
import { SlashMenu, type MenuHandle, type SlashItem } from "./slash-menu.tsx";

/** The shared date node, drawn as a chip with a picker; the schema is unchanged. */
export const DocumentDateChip = DateChip.extend({
  addNodeView: () => ReactNodeViewRenderer(DateChipView, { as: "span" }),
});

const asItem = (candidate: MentionCandidate): SlashItem => ({
  title: candidate.label,
  icon: UserIcon,
  keywords: candidate.id,
  run: () => {},
});

const menuProps = (props: SuggestionProps<MentionCandidate>) => ({
  items: props.items.map(asItem),
  command: (item: SlashItem) => props.command({ id: item.keywords, label: item.title }),
});

/** Type @ to mention someone who can see the document. */
export const DocumentMention = PersonMention.extend({
  addOptions() {
    const parent = this.parent?.();
    return {
      ...parent!,
      suggestion: {
        ...parent!.suggestion,
        char: "@",
        // A collaborator's typing must never open this person's list.
        shouldShow: ({ transaction }) => !isRemoteChange(transaction),
        items: ({ query, editor }) => {
          const needle = query.trim().toLowerCase();
          return editorHooks(editor)
            .mentions()
            .filter((candidate) =>
              `${candidate.label} ${candidate.detail ?? ""}`.toLowerCase().includes(needle),
            )
            .slice(0, 8);
        },
        render: () => {
          let renderer: ReactRenderer<MenuHandle> | null = null;
          let unmount: (() => void) | null = null;
          return {
            onStart: (props: SuggestionProps<MentionCandidate>) => {
              renderer = new ReactRenderer(SlashMenu, {
                props: menuProps(props),
                editor: props.editor,
              });
              unmount = props.mount(renderer.element);
            },
            onUpdate: (props: SuggestionProps<MentionCandidate>) =>
              renderer?.updateProps(menuProps(props)),
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
      },
    };
  },
});
