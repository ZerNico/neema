import { useStore } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DraftSettings,
  EMPTY_AGENT_DRAFT,
  type AgentDraft,
  type AgentDraftPatch,
} from "../draft-schema.ts";
import {
  discardAgentDraft,
  patchAgentDraft,
  reloadAgentDraft,
  saveAgentDraft,
} from "../server/draft-functions.ts";
import { useAppForm } from "~/ui/form/app-form.tsx";
import { agentDraftQuery } from "./draft-queries.ts";
import {
  DRAFT_FIELDS,
  draftChanges,
  reconcileAgentDraft,
  sameDraftValue,
  type DraftField,
  sameDraftSettings,
} from "./draft-reconciliation.ts";

const failureMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

/** One per draft, mounted at conversation level, never inside the replaceable panel body. */
export function useAgentDraft(draftId: string, enabled = true) {
  const client = useQueryClient();
  const query = useQuery({ ...agentDraftQuery(draftId), enabled });
  const form = useAppForm({ defaultValues: EMPTY_AGENT_DRAFT });
  const values = useStore(form.store, (state) => state.values);
  const canonical = useRef<AgentDraft | null>(null);
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const conflictRef = useRef<ReadonlyArray<DraftField>>([]);
  const [conflicts, setConflicts] = useState<ReadonlyArray<DraftField>>([]);
  const [error, setError] = useState<string | null>(null);
  const [autosaving, setAutosaving] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [agentChanged, setAgentChanged] = useState(false);
  const pendingChanges = useRef<AgentDraftPatch | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const paused = useRef(false);
  const active = useRef(true);
  const reviewEpoch = useRef(0);
  const updateConflicts = useCallback((next: ReadonlyArray<DraftField>) => {
    conflictRef.current = next;
    setConflicts(next);
  }, []);
  const accept = useCallback(
    (incoming: AgentDraft) => {
      const next = reconcileAgentDraft(
        canonical.current,
        incoming,
        form.state.values,
        conflictRef.current,
        pendingChanges.current,
      );
      canonical.current = next.draft;
      if (next.reviewChanged) reviewEpoch.current++;
      DRAFT_FIELDS.forEach((key) => {
        if (!sameDraftValue(form.state.values[key], next.values[key]))
          form.setFieldValue(key, next.values[key]);
      });
      updateConflicts(next.conflicts);
      setDraft(next.draft);
      return next.draft;
    },
    [form, updateConflicts],
  );
  const remember = useCallback(
    (incoming: AgentDraft) => {
      const current = accept(incoming);
      client.setQueryData(agentDraftQuery(draftId).queryKey, current);
    },
    [accept, client, draftId],
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
          const latest = await client.fetchQuery(agentDraftQuery(draftId));
          if (!latest) throw new Error("This agent draft is no longer available.");
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
          const changes = draftChanges(base.settings, local);
          if (Object.keys(changes).length === 0) {
            if (reviewEpoch.current !== reviewed) {
              setError("The draft changed. Review it before continuing.");
              return false;
            }
            return true;
          }
          if (!Schema.is(DraftSettings)(local)) {
            setError("Some draft fields are too long or invalid. Check them before continuing.");
            return false;
          }
          pendingChanges.current = changes;
          // oxlint-disable-next-line eslint/no-await-in-loop -- Each CAS write needs the preceding acknowledgement.
          const result = await patchAgentDraft({
            data: { draftId, expectedRevision: base.revision, changes },
          });
          remember(result.draft);
          pendingChanges.current = null;
          // Rebase only the fields still dirty. Conflicting fields are never retried automatically.
        }
        // The last attempt may have persisted everything: only report failure
        // when changes are genuinely still outstanding.
        if (canonical.current && sameDraftSettings(form.state.values, canonical.current.settings))
          return true;
        setError("The draft is still changing. Review it and try again.");
        return false;
      } catch (failure) {
        setError(
          failureMessage(
            failure,
            "Could not keep your draft changes. Try again before continuing.",
          ),
        );
        return false;
      } finally {
        pendingChanges.current = null;
        if (active.current) setAutosaving(false);
      }
    },
    [accept, client, draftId, form, remember],
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
    if (
      !canonical.current ||
      paused.current ||
      sameDraftSettings(values, canonical.current.settings)
    )
      return;
    const timer = window.setTimeout(() => {
      void enqueue(false);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [values, enqueue]);

  const resolve = useCallback(
    (key: DraftField, choice: "local" | "remote") => {
      if (!canonical.current) return;
      if (choice === "remote") form.setFieldValue(key, canonical.current.settings[key]);
      updateConflicts(conflictRef.current.filter((field) => field !== key));
      setError(null);
      void enqueue(false);
    },
    [enqueue, form, updateConflicts],
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
      const result = await saveAgentDraft({
        data: { draftId, expectedRevision: base.revision },
      });
      remember(result.draft);
      if (result.outcome === "saved") {
        setAgentChanged(false);
        setError(null);
        void client.invalidateQueries({ queryKey: ["agents", "list"] });
        void client.invalidateQueries({ queryKey: ["agents", "detail", result.agentId] });
      } else if (result.outcome === "invalid") setError(result.reason);
      else if (result.outcome === "agent_changed") {
        setAgentChanged(true);
        setError(
          "This agent changed elsewhere. Your draft is kept. View the current agent or reload it before saving.",
        );
      } else if (result.outcome === "agent_unavailable")
        setError("The original agent is no longer available. This draft cannot replace it.");
      else setError("The draft changed. Review it, then choose Save again.");
    } catch (failure) {
      setError(failureMessage(failure, "Could not save the agent."));
    } finally {
      if (active.current) setSaving(false);
    }
  }, [client, draftId, flush, form, reloading, remember, saving]);
  const reload = useCallback(async () => {
    if (saving || reloading) return;
    paused.current = true;
    setReloading(true);
    try {
      await queue.current;
      const base = canonical.current;
      if (!base) return;
      const result = await reloadAgentDraft({
        data: { draftId, expectedRevision: base.revision },
      });
      if (result.outcome === "reloaded") {
        canonical.current = result.draft;
        form.reset(result.draft.settings, { keepDefaultValues: true });
        updateConflicts([]);
        reviewEpoch.current++;
        remember(result.draft);
        setAgentChanged(false);
        setError(null);
      } else {
        remember(result.draft);
        setError(
          result.outcome === "conflict"
            ? "The draft changed. Review it before reloading."
            : "The original agent is no longer available.",
        );
      }
    } catch (failure) {
      setError(failureMessage(failure, "Could not reload the agent."));
    } finally {
      paused.current = false;
      if (active.current) setReloading(false);
    }
  }, [draftId, form, reloading, remember, saving, updateConflicts]);
  const discard = useCallback(async () => {
    if (!canonical.current) return false;
    paused.current = true;
    try {
      await queue.current;
      await discardAgentDraft({ data: { draftId } });
      client.setQueryData(agentDraftQuery(draftId).queryKey, null);
      return true;
    } catch (failure) {
      setError(failureMessage(failure, "Could not discard the draft."));
      paused.current = false;
      return false;
    }
  }, [client, draftId]);
  const unpersisted = useCallback(
    () =>
      canonical.current !== null &&
      !sameDraftSettings(form.state.values, canonical.current.settings),
    [form],
  );
  const dirty = draft !== null && !sameDraftSettings(values, draft.settings);
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
    agentChanged,
    dirty,
    flush,
    save,
    reload,
    discard,
    resolve,
    unpersisted,
  };
}
