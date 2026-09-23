import type { ConversationDraft } from "../draft-schema.ts";

export type DraftFields<S> = ReadonlyArray<keyof S & string>;
export const sameDraftValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/**
 * Field by field, never the whole object: settings come back from a jsonb
 * column with its own key order, so a serialized compare of two equal drafts
 * reads as a pending change.
 */
export const sameDraftSettings = <S>(fields: DraftFields<S>, a: S, b: S) =>
  fields.every((key) => sameDraftValue(a[key], b[key]));
export const draftChanges = <S>(fields: DraftFields<S>, base: S, values: S): Partial<S> =>
  Object.fromEntries(
    fields
      .filter((key) => !sameDraftValue(base[key], values[key]))
      .map((key) => [key, values[key]]),
  ) as Partial<S>;

/** Arrays and prose are whole fields, not a text-merge/history engine. */
export function reconcileDraft<S>(
  fields: DraftFields<S>,
  previous: ConversationDraft<S> | null,
  incoming: ConversationDraft<S>,
  local: S,
  conflicts: ReadonlyArray<keyof S & string>,
  pending: Partial<S> | null = null,
) {
  if (
    previous &&
    (incoming.revision < previous.revision ||
      (incoming.revision === previous.revision &&
        (incoming.savedDraftRevision ?? 0) < (previous.savedDraftRevision ?? 0)))
  )
    return { draft: previous, values: local, conflicts, reviewChanged: false };
  if (!previous)
    return { draft: incoming, values: incoming.settings, conflicts: [], reviewChanged: false };
  const values = { ...local };
  const nextConflicts = new Set(conflicts);
  let reviewChanged = false;
  for (const key of fields) {
    const before = previous.settings[key];
    const remote = incoming.settings[key];
    if (sameDraftValue(local[key], remote)) {
      nextConflicts.delete(key);
      continue;
    }
    // An acknowledgement of our own in-flight field is not a competing edit.
    // A keystroke made after dispatch still stays local and dirty against it.
    if (pending && key in pending && sameDraftValue(pending[key], remote)) {
      nextConflicts.delete(key);
      continue;
    }
    if (sameDraftValue(before, remote)) continue;
    reviewChanged = true;
    if (sameDraftValue(local[key], before)) {
      values[key] = remote;
      nextConflicts.delete(key);
    } else nextConflicts.add(key);
  }
  return { draft: incoming, values, conflicts: [...nextConflicts], reviewChanged };
}
