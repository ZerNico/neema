import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { sessionUserQuery } from "~/modules/auth/client.ts";
import { pushDocument } from "../server/document-functions.ts";
import { taskMarkerOffset } from "../task-items.ts";
import { documentQuery } from "./document-queries.ts";
import { DocumentSync } from "./document-sync.ts";

const CURSOR_COLORS = ["--chart-1", "--chart-2", "--chart-3", "--chart-4"] as const;
/** A stable colour per person, so their cursor looks the same in every tab. */
const cursorUser = (user: { id: string; name: string } | null | undefined) => {
  const id = user?.id ?? "";
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  const token = CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length]!;
  return {
    name: user?.name ?? "You",
    color: `var(${token})`,
    colorLight: `color-mix(in oklab, var(${token}) 25%, transparent)`,
  };
};
/**
 * The connections one controller owns, as an external store: the open one,
 * and any closed one still sending its last changes. Read through
 * `useSyncExternalStore`, so opening and closing never set state in an effect.
 */
class Connections {
  current: DocumentSync | null = null;
  readonly all = new Set<DocumentSync>();
  version = 0;
  #listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #scheduled = false;
  /**
   * Coalesced onto a later task. A Yjs change can land while React is still
   * committing (the editor applies typed text during any view update), and a
   * store change delivered then nests another synchronous render inside it.
   */
  #changed = () => {
    if (this.#scheduled) return;
    this.#scheduled = true;
    setTimeout(() => {
      this.#scheduled = false;
      this.version++;
      for (const listener of this.#listeners) listener();
    }, 0);
  };
  open(documentId: string) {
    const next = new DocumentSync({
      documentId,
      push: (data) => pushDocument({ data }),
      user: cursorUser(null),
    });
    this.all.add(next);
    this.current = next;
    const unsubscribe = next.subscribe(this.#changed);
    this.#changed();
    return () => {
      unsubscribe();
      if (this.current === next) this.current = null;
      this.#changed();
      void next.flush().finally(() => {
        this.all.delete(next);
        next.destroy();
      });
    };
  }
}

/**
 * One controller per document, mounted at conversation level outside the
 * panel body. Only a `live` document holds a connection; the rest show the
 * stored markdown, refreshed by `document.changed`. A connection that goes
 * out of use stays until its last change is acknowledged.
 */
export function useDocument(documentId: string, live: boolean) {
  const query = useQuery(documentQuery(documentId));
  const { data: user } = useQuery(sessionUserQuery);
  const [connections] = useState(() => new Connections());
  useEffect(
    () => (live ? connections.open(documentId) : undefined),
    [connections, documentId, live],
  );
  useSyncExternalStore(
    connections.subscribe,
    () => connections.version,
    () => 0,
  );
  const sync = connections.current;
  // Kept apart from the connection, so the session loading late never reconnects it.
  useEffect(() => {
    sync?.awareness.setLocalStateField("user", cursorUser(user));
  }, [sync, user]);

  const synced = sync?.synced ?? false;
  const content = synced ? sync!.text.toString() : (query.data?.content ?? "");

  /** Persist everything typed so far, including editors that just closed. */
  const flush = useCallback(async () => {
    const results = await Promise.all([...connections.all].map((each) => each.flush()));
    return results.every(Boolean);
  }, [connections]);

  /** A tick is the one marker character, so it merges beside anyone's typing. */
  const toggleTask = useCallback(
    (ordinal: number, checked: boolean) => {
      if (!sync?.synced) return;
      const offset = taskMarkerOffset(sync.text.toString(), ordinal);
      if (offset === null) return;
      sync.doc.transact(() => {
        sync.text.delete(offset, 1);
        sync.text.insert(offset, checked ? "x" : " ");
      });
    },
    [sync],
  );

  const unpersisted = useCallback(
    () => [...connections.all].some((each) => each.pending()),
    [connections],
  );

  return {
    query,
    document: query.data ?? null,
    content,
    sync: synced ? sync : null,
    status: sync?.status ?? null,
    error: sync?.error ?? null,
    flush,
    toggleTask,
    unpersisted,
  };
}
export type DocumentController = ReturnType<typeof useDocument>;
