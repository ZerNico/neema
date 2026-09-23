import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { DOCUMENT_LIMITS, type ConversationDocument } from "../schema.ts";
import { saveDocument, toggleDocumentTask } from "../server/document-functions.ts";
import { toggleTaskItem } from "../task-items.ts";
import { documentQuery } from "./document-queries.ts";
import { reconcileDocument } from "./document-reconciliation.ts";

const failureMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

/** One controller per document, mounted at conversation level outside the panel body. */
export function useDocument(documentId: string, enabled = true, locked = false) {
  const client = useQueryClient();
  const query = useQuery({ ...documentQuery(documentId), enabled });
  const canonical = useRef<ConversationDocument | null>(null);
  const local = useRef("");
  const conflictRef = useRef(false);
  const pending = useRef<string | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const active = useRef(true);
  const [document, setDocument] = useState<ConversationDocument | null>(null);
  const [content, setContentState] = useState("");
  const [conflict, setConflictState] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Source the editor must adopt, distinct from source the person typed. The
   * editor is a snapshot in panel state and so trails this hook by a render; a
   * plain `value` would then be pushed back into CodeMirror on any unrelated
   * re-render and erase the keystrokes it had not seen yet. The epoch only
   * moves when we genuinely replace the text, so a late snapshot is inert.
   */
  const [external, setExternal] = useState({ text: "", epoch: 0 });

  const setContent = useCallback((value: string) => {
    local.current = value;
    setContentState(value);
  }, []);
  const replaceContent = useCallback((value: string) => {
    local.current = value;
    setContentState(value);
    setExternal((current) => ({ text: value, epoch: current.epoch + 1 }));
  }, []);
  const setConflict = useCallback((value: boolean) => {
    conflictRef.current = value;
    setConflictState(value);
  }, []);
  const accept = useCallback(
    (incoming: ConversationDocument) => {
      const next = reconcileDocument(
        canonical.current,
        incoming,
        local.current,
        conflictRef.current,
        pending.current,
      );
      const replaced = next.content !== local.current;
      canonical.current = next.document;
      conflictRef.current = next.conflict;
      setDocument(next.document);
      setConflictState(next.conflict);
      if (replaced) replaceContent(next.content);
      return next.document;
    },
    [replaceContent],
  );
  const remember = useCallback(
    (incoming: ConversationDocument) => {
      const current = accept(incoming);
      client.setQueryData(documentQuery(documentId).queryKey, current);
    },
    [accept, client, documentId],
  );
  useEffect(() => {
    if (query.data) accept(query.data);
  }, [accept, query.data]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  const drain = useCallback(async (): Promise<boolean> => {
    if (!active.current) return true;
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const base = canonical.current;
        if (!base) return true;
        if (conflictRef.current && local.current !== base.content) {
          setError("Choose which document to keep before continuing.");
          return false;
        }
        const value = local.current;
        if (value === base.content) {
          setError(null);
          return true;
        }
        if (value.length > DOCUMENT_LIMITS.chars) {
          setError(
            `Documents can contain up to ${DOCUMENT_LIMITS.chars.toLocaleString()} characters.`,
          );
          return false;
        }
        // Held until the reply lands so a keystroke made while this write was in
        // flight is recognised as ours coming back, not as a competing edit.
        pending.current = value;
        // oxlint-disable-next-line eslint/no-await-in-loop -- Each CAS write uses the preceding receipt.
        const result = await saveDocument({
          data: { documentId, content: value, expectedRevision: base.revision },
        });
        remember(result.document);
        pending.current = null;
        if (result.outcome === "conflict") {
          // A revision can move without the source moving (another tab's tick
          // landing first). Only a real text divergence needs a decision.
          if (!conflictRef.current) continue;
          setError("The document changed while you were editing.");
          return false;
        }
        setError(null);
      }
      if (canonical.current && local.current === canonical.current.content) return true;
      setError("The document is still changing. Review it and try again.");
      return false;
    } catch (failure) {
      setError(failureMessage(failure, "Could not keep your document changes."));
      return false;
    } finally {
      pending.current = null;
    }
  }, [documentId, remember]);
  const enqueue = useCallback((work: () => Promise<boolean>) => {
    const next = queue.current.then(work, work);
    queue.current = next;
    return next;
  }, []);
  /** Persist everything typed so far; never refetches, so it cannot adopt mid-edit. */
  const flush = useCallback(() => enqueue(drain), [drain, enqueue]);
  useEffect(() => {
    if (!canonical.current || locked || content === canonical.current.content) return;
    const timer = window.setTimeout(() => {
      void enqueue(drain);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [content, drain, enqueue, locked]);

  const resolve = useCallback(
    (choice: "local" | "remote") => {
      const current = canonical.current;
      if (!current) return;
      setConflict(false);
      setError(null);
      if (choice === "remote") replaceContent(current.content);
      else void enqueue(drain);
    },
    [drain, enqueue, replaceContent, setConflict],
  );

  /**
   * A tick is applied to the local source immediately, so the box never waits
   * for a round trip or flips back under the person. When that is the only
   * local change it is sent as an ordinal patch with no revision precondition:
   * the server rewrites just that line under the conversation lock, which lands
   * beside a model edit elsewhere instead of racing it.
   */
  const toggleTask = useCallback(
    (ordinal: number, checked: boolean) => {
      const base = canonical.current;
      if (!base || locked) return;
      const next = toggleTaskItem(local.current, ordinal, checked);
      if (next === null) {
        setError("That task is no longer in the document.");
        return;
      }
      const wasClean = local.current === base.content;
      replaceContent(next);
      setError(null);
      if (!wasClean) return;
      void enqueue(async () => {
        if (!active.current) return true;
        try {
          const result = await toggleDocumentTask({ data: { documentId, ordinal, checked } });
          remember(result.document);
          if (result.outcome === "no_match") {
            replaceContent(result.document.content);
            setError("That task is no longer in the document.");
            return false;
          }
          return true;
        } catch (failure) {
          setError(failureMessage(failure, "Could not update that task."));
          return false;
        }
      });
    },
    [documentId, enqueue, locked, remember, replaceContent],
  );

  const unpersisted = useCallback(
    () => canonical.current !== null && local.current !== canonical.current.content,
    [],
  );

  return {
    query,
    document,
    content,
    external,
    conflict,
    error,
    locked,
    dirty: document !== null && content !== document.content,
    setContent,
    flush,
    resolve,
    toggleTask,
    unpersisted,
  };
}
