import { useLayoutEffect, useRef, type RefObject } from "react";
import { findTags, type ContextTag } from "../tags.ts";
import type { ComposerFieldHandle } from "./chat-textarea.tsx";

/** One kind of pick the draft can carry as tags: the user's skills, or collections. */
export interface TagSide {
  kind: ContextTag["kind"];
  /** What this message is set to load, the user's own picks only (never the agent's). */
  selected: readonly string[];
  /** The name to show, or undefined while it is not known yet. */
  nameOf: (id: string) => string | undefined;
  /** Whether this person may pick it: a tag naming one they cannot use only names it. */
  canSelect: (id: string) => boolean;
  select: (ids: readonly string[]) => void;
  deselect: (ids: readonly string[]) => void;
}

/**
 * Keeps the draft's /skill and #collection tags and the message's selection in
 * step. The selection is what loads a skill or collection; a tag is how it
 * shows in the text. Each commit is compared with the one before, so whichever
 * side changed leads:
 * - a tag gone from the text while still selected deselects it;
 * - a selection with no tag (a + menu pick, an older message being edited)
 *   gets its tag at the caret;
 * - a deselection made elsewhere (the + menu picker) takes its tags out;
 * - a tag that appears unselected (pasted, or an edit whose message kept the
 *   words but not the pick) selects it, if it is one this person can use.
 * Sending clears both at once, which matches on neither side.
 */
export function useTagSync(
  value: string,
  field: RefObject<ComposerFieldHandle | null>,
  sides: readonly TagSide[],
) {
  const previous = useRef(new Map<string, { tags: Set<string>; selected: Set<string> }>());
  useLayoutEffect(() => {
    const found = findTags(value);
    for (const side of sides) {
      const tags = new Set(found.filter((tag) => tag.kind === side.kind).map((tag) => tag.id));
      const selected = new Set(side.selected);
      const prior = previous.current.get(side.kind);
      // A tag that cannot be selected yet (its list still loading) is not
      // remembered, so it counts as new again until it can be.
      const waiting = new Set([...tags].filter((id) => !selected.has(id) && !side.canSelect(id)));
      previous.current.set(side.kind, {
        tags: new Set([...tags].filter((id) => !waiting.has(id))),
        selected,
      });

      const appeared = [...tags].filter(
        (id) => !prior?.tags.has(id) && !selected.has(id) && side.canSelect(id),
      );
      if (appeared.length > 0) side.select(appeared);
      if (prior) {
        const untagged = [...prior.tags].filter((id) => !tags.has(id) && selected.has(id));
        if (untagged.length > 0) side.deselect(untagged);
        const dropped = [...prior.selected].filter((id) => !selected.has(id) && tags.has(id));
        if (dropped.length > 0) field.current?.removeTags(side.kind, new Set(dropped));
      }
      // A tag the text just lost is being deselected, not re-added.
      const missing = [...selected].flatMap((id) => {
        if (tags.has(id) || prior?.tags.has(id)) return [];
        const name = side.nameOf(id);
        return name === undefined ? [] : [{ kind: side.kind, id, name }];
      });
      if (missing.length > 0) field.current?.insertTags(missing);
    }
  });
}
