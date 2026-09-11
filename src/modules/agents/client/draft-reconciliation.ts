import {
  EMPTY_AGENT_DRAFT,
  type AgentDraft,
  type AgentDraftPatch,
  type DraftSettings,
} from "../draft-schema.ts";

export type DraftField = keyof DraftSettings;
export const DRAFT_FIELDS = Object.keys(EMPTY_AGENT_DRAFT) as DraftField[];
export const sameDraftValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/**
 * Field by field, never the whole object: settings come back from a jsonb
 * column with its own key order, so a serialized compare of two equal drafts
 * reads as a pending change.
 */
export const sameDraftSettings = (a: DraftSettings, b: DraftSettings) =>
  DRAFT_FIELDS.every((key) => sameDraftValue(a[key], b[key]));
export const draftChanges = (base: DraftSettings, values: DraftSettings): AgentDraftPatch =>
  Object.fromEntries(
    DRAFT_FIELDS.filter((key) => !sameDraftValue(base[key], values[key])).map((key) => [
      key,
      values[key],
    ]),
  );

/** Arrays and instructions are whole fields, not a text-merge/history engine. */
export function reconcileAgentDraft(
  previous: AgentDraft | null,
  incoming: AgentDraft,
  local: DraftSettings,
  conflicts: ReadonlyArray<DraftField>,
  pending: AgentDraftPatch | null = null,
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
  const apply = <K extends DraftField>(key: K) => {
    const before = previous.settings[key];
    const remote = incoming.settings[key];
    if (sameDraftValue(local[key], remote)) {
      nextConflicts.delete(key);
      return;
    }
    // An acknowledgement of our own in-flight field is not a competing edit.
    // A keystroke made after dispatch still stays local and dirty against it.
    if (pending && key in pending && sameDraftValue(pending[key], remote)) {
      nextConflicts.delete(key);
      return;
    }
    if (sameDraftValue(before, remote)) return;
    reviewChanged = true;
    if (sameDraftValue(local[key], before)) {
      values[key] = remote;
      nextConflicts.delete(key);
    } else nextConflicts.add(key);
  };
  DRAFT_FIELDS.forEach(apply);
  return { draft: incoming, values, conflicts: [...nextConflicts], reviewChanged };
}
