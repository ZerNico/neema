import { useStore } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAppForm } from "~/ui/form/app-form.tsx";
import type { ConversationDraft, DraftKind } from "../draft-schema.ts";
import { draftQuery } from "./draft-queries.ts";
import {
  draftChanges,
  reconcileDraft,
  sameDraftSettings,
  sameDraftValue,
  type DraftFields,
} from "./reconciliation.ts";

export type SaveDraftOutcome<S> =
  | { outcome: "saved"; draft: ConversationDraft<S>; targetId: string }
  | { outcome: "conflict" | "target_changed" | "target_unavailable"; draft: ConversationDraft<S> }
  | { outcome: "invalid"; draft: ConversationDraft<S>; reason: string };
export type ReloadDraftOutcome<S> = {
  outcome: "reloaded" | "conflict" | "target_unavailable" | "no_target";
  draft: ConversationDraft<S>;
};

/**
 * What one kind of draft brings to the shared controller: its shape, its
 * server functions with the per-kind outcomes folded to the common ones, and
 * the words the errors use for the thing being authored.
 */
export interface DraftClient<S extends Record<string, unknown>> {
  kind: DraftKind;
  fields: DraftFields<S>;
  empty: S;
  /** Whether the working values are within the limits a patch accepts. */
  isValid: (values: S) => boolean;
  get: (draftId: string) => Promise<ConversationDraft<S> | null>;
  patch: (input: {
    draftId: string;
    expectedRevision: number;
    changes: Partial<S>;
  }) => Promise<{ outcome: "updated" | "unchanged" | "conflict"; draft: ConversationDraft<S> }>;
  save: (input: { draftId: string; expectedRevision: number }) => Promise<SaveDraftOutcome<S>>;
  reload: (input: { draftId: string; expectedRevision: number }) => Promise<ReloadDraftOutcome<S>>;
  discard: (input: { draftId: string }) => Promise<unknown>;
  /** Query keys the saved resource's own pages read; refreshed after a save. */
  invalidateOnSave: (targetId: string) => ReadonlyArray<ReadonlyArray<unknown>>;
  /** "agent", "schedule": the noun in the copy below. */
  noun: string;
}

const failureMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

/** One per draft, mounted at conversation level, never inside the replaceable panel body. */
export function useDraft<S extends Record<string, unknown>>(
  client: DraftClient<S>,
  draftId: string,
  enabled = true,
) {
  type Field = keyof S & string;
  const queries = useQueryClient();
  const query = useQuery({ ...draftQuery(client.kind, draftId, client.get), enabled });
  const form = useAppForm({ defaultValues: client.empty });
  const values = useStore(form.store, (state) => state.values);
  const canonical = useRef<ConversationDraft<S> | null>(null);
  const [draft, setDraft] = useState<ConversationDraft<S> | null>(null);
  const conflictRef = useRef<ReadonlyArray<Field>>([]);
  const [conflicts, setConflicts] = useState<ReadonlyArray<Field>>([]);
  const [error, setError] = useState<string | null>(null);
  const [autosaving, setAutosaving] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [targetChanged, setTargetChanged] = useState(false);
  const pendingChanges = useRef<Partial<S> | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const paused = useRef(false);
  const active = useRef(true);
  const reviewEpoch = useRef(0);
  const { fields, noun } = client;
  const same = useCallback((a: S, b: S) => sameDraftSettings(fields, a, b), [fields]);
  const setField = useCallback(
    (key: Field, value: S[Field]) => form.setFieldValue(key as never, value as never),
    [form],
  );
  const updateConflicts = useCallback((next: ReadonlyArray<Field>) => {
    conflictRef.current = next;
    setConflicts(next);
  }, []);
  const accept = useCallback(
    (incoming: ConversationDraft<S>) => {
      const next = reconcileDraft(
        fields,
        canonical.current,
        incoming,
        form.state.values,
        conflictRef.current,
        pendingChanges.current,
      );
      canonical.current = next.draft;
      if (next.reviewChanged) reviewEpoch.current++;
      for (const key of fields)
        if (!sameDraftValue(form.state.values[key], next.values[key]))
          setField(key, next.values[key]);
      updateConflicts(next.conflicts);
      setDraft(next.draft);
      return next.draft;
    },
    [fields, form, setField, updateConflicts],
  );
  const queryKey = draftQuery(client.kind, draftId, client.get).queryKey;
  const remember = useCallback(
    (incoming: ConversationDraft<S>) => {
      queries.setQueryData(queryKey, accept(incoming));
    },
    [accept, queries, queryKey],
  );
  useEffect(() => {
    if (query.data) accept(query.data);
  }, [query.data, accept]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  const drain = useCallback(
    async (refresh: boolean): Promise<boolean> => {
      if (!active.current || paused.current) return false;
      const reviewed = reviewEpoch.current;
      setError(null);
      setAutosaving(true);
      try {
        if (refresh) {
          const latest = await queries.fetchQuery(draftQuery(client.kind, draftId, client.get));
          if (!latest) throw new Error(`This ${noun} draft is no longer available.`);
          accept(latest);
        }
        for (let attempt = 0; attempt < 5; attempt++) {
          const base = canonical.current;
          if (!base) return false;
          const local = form.state.values;
          const unresolved = conflictRef.current.filter(
            (key) => !sameDraftValue(local[key], base.settings[key]),
          );
          if (unresolved.length) {
            setError("Choose which value to keep for the conflicting fields.");
            return false;
          }
          const changes = draftChanges(fields, base.settings, local);
          if (Object.keys(changes).length === 0) {
            if (reviewEpoch.current !== reviewed) {
              setError("The draft changed. Review it before continuing.");
              return false;
            }
            return true;
          }
          if (!client.isValid(local)) {
            setError("Some draft fields are too long or invalid. Check them before continuing.");
            return false;
          }
          pendingChanges.current = changes;
          // oxlint-disable-next-line eslint/no-await-in-loop -- Each CAS write needs the preceding acknowledgement.
          const result = await client.patch({
            draftId,
            expectedRevision: base.revision,
            changes,
          });
          remember(result.draft);
          pendingChanges.current = null;
          // Rebase only the fields still dirty. Conflicting fields are never retried automatically.
        }
        // The last attempt may have persisted everything: only report failure
        // when changes are genuinely still outstanding.
        if (canonical.current && same(form.state.values, canonical.current.settings)) return true;
        setError("The draft is still changing. Review it and try again.");
        return false;
      } catch (failure) {
        setError(
          failureMessage(failure, "Could not keep your draft changes. Try again before continuing."),
        );
        return false;
      } finally {
        pendingChanges.current = null;
        if (active.current) setAutosaving(false);
      }
    },
    [accept, client, draftId, fields, form, noun, queries, remember, same],
  );
  const enqueue = useCallback(
    (refresh: boolean) => {
      const next = queue.current.then(() => drain(refresh));
      queue.current = next;
      return next;
    },
    [drain],
  );
  const flush = useCallback(() => enqueue(true), [enqueue]);
  useEffect(() => {
    if (!canonical.current || paused.current || same(values, canonical.current.settings)) return;
    const timer = window.setTimeout(() => {
      void enqueue(false);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [values, enqueue, same]);

  const resolve = useCallback(
    (key: Field, choice: "local" | "remote") => {
      if (!canonical.current) return;
      if (choice === "remote") setField(key, canonical.current.settings[key]);
      updateConflicts(conflictRef.current.filter((field) => field !== key));
      setError(null);
      void enqueue(false);
    },
    [enqueue, setField, updateConflicts],
  );
  const save = useCallback(async () => {
    if (saving || reloading) return;
    setSaving(true);
    const seen = form.state.values;
    const reviewed = reviewEpoch.current;
    try {
      const ready = await flush();
      if (!ready) {
        if (reviewed !== reviewEpoch.current)
          setError("The draft changed. Review it, then choose Save again.");
        return;
      }
      if (reviewed !== reviewEpoch.current || !sameDraftValue(seen, form.state.values)) {
        setError("The draft changed. Review it, then choose Save again.");
        return;
      }
      const base = canonical.current;
      if (!base) return;
      const result = await client.save({ draftId, expectedRevision: base.revision });
      remember(result.draft);
      if (result.outcome === "saved") {
        setTargetChanged(false);
        setError(null);
        for (const key of client.invalidateOnSave(result.targetId))
          void queries.invalidateQueries({ queryKey: key });
      } else if (result.outcome === "invalid") setError(result.reason);
      else if (result.outcome === "target_changed") {
        setTargetChanged(true);
        setError(
          `This ${noun} changed elsewhere. Your draft is kept. View the current ${noun} or reload it before saving.`,
        );
      } else if (result.outcome === "target_unavailable")
        setError(`The original ${noun} is no longer available. This draft cannot replace it.`);
      else setError("The draft changed. Review it, then choose Save again.");
    } catch (failure) {
      setError(failureMessage(failure, `Could not save the ${noun}.`));
    } finally {
      if (active.current) setSaving(false);
    }
  }, [client, draftId, flush, form, noun, queries, reloading, remember, saving]);
  const reload = useCallback(async () => {
    if (saving || reloading) return;
    paused.current = true;
    setReloading(true);
    try {
      await queue.current;
      const base = canonical.current;
      if (!base) return;
      const result = await client.reload({ draftId, expectedRevision: base.revision });
      if (result.outcome === "reloaded") {
        canonical.current = result.draft;
        form.reset(result.draft.settings, { keepDefaultValues: true });
        updateConflicts([]);
        reviewEpoch.current++;
        remember(result.draft);
        setTargetChanged(false);
        setError(null);
      } else {
        remember(result.draft);
        setError(
          result.outcome === "conflict"
            ? "The draft changed. Review it before reloading."
            : `The original ${noun} is no longer available.`,
        );
      }
    } catch (failure) {
      setError(failureMessage(failure, `Could not reload the ${noun}.`));
    } finally {
      paused.current = false;
      if (active.current) setReloading(false);
    }
  }, [client, draftId, form, noun, reloading, remember, saving, updateConflicts]);
  const discard = useCallback(async () => {
    if (!canonical.current) return false;
    paused.current = true;
    try {
      await queue.current;
      await client.discard({ draftId });
      queries.setQueryData(queryKey, null);
      return true;
    } catch (failure) {
      setError(failureMessage(failure, "Could not discard the draft."));
      paused.current = false;
      return false;
    }
  }, [client, draftId, queries, queryKey]);
  const unpersisted = useCallback(
    () => canonical.current !== null && !same(form.state.values, canonical.current.settings),
    [form, same],
  );
  const dirty = draft !== null && !same(values, draft.settings);
  const visibleConflicts = conflicts.filter(
    (key) => draft && !sameDraftValue(values[key], draft.settings[key]),
  );
  return {
    query,
    form,
    values,
    draft,
    conflicts: visibleConflicts,
    error,
    autosaving,
    saving,
    reloading,
    targetChanged,
    dirty,
    flush,
    save,
    reload,
    discard,
    resolve,
    unpersisted,
  };
}
export type DraftController<S extends Record<string, unknown>> = ReturnType<typeof useDraft<S>>;
