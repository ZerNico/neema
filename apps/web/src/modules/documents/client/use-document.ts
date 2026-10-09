import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { sessionUserQuery } from "~/modules/auth/client.ts";
import { pushDocument } from "../server/document-functions.ts";
import { documentQuery } from "./document-queries.ts";
import type { DocumentSync } from "./document-sync.ts";

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
 * The connection, its editor and the unsent-changes store, loaded with the
 * first open document rather than the chat.
 */
const loadSync = async () => {
  const [{ DocumentSync }, { browserEditorExtensions, browserEditorProps }, { outbox }] =
    await Promise.all([
      import("./document-sync.ts"),
      import("../ui/rich-editor/editor-extensions.ts"),
      import("./outbox.ts"),
    ]);
  await outbox.warm();
  return (documentId: string) =>
    new DocumentSync({
      documentId,
      push: (data) => pushDocument({ data }),
      extensions: browserEditorExtensions,
      editorProps: browserEditorProps,
      outbox,
      user: cursorUser(null),
    });
};
let syncFactory: ReturnType<typeof loadSync> | null = null;

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
   * Coalesced onto a later task. An editor change can land while React is
   * still committing, and a store change delivered then nests another
   * synchronous render inside it.
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
    let closed = false;
    let opened: DocumentSync | null = null;
    let unsubscribe: (() => void) | null = null;
    void (syncFactory ??= loadSync()).then((create) => {
      if (closed) return;
      const next = create(documentId);
      opened = next;
      this.all.add(next);
      this.current = next;
      unsubscribe = next.subscribe(this.#changed);
      this.#changed();
    });
    return () => {
      closed = true;
      unsubscribe?.();
      const next = opened;
      if (!next) return;
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
 * out of use stays until its last change is stored.
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
    sync?.setUser(cursorUser(user));
  }, [sync, user]);

  const editor = sync?.editor ?? null;
  // The stored Markdown, which follows typing within a second. Reading the
  // live tree as Markdown would load the editor's schema with every chat.
  const content = query.data?.content ?? "";

  /** Persist everything typed so far, including editors that just closed. */
  const flush = useCallback(async () => {
    const results = await Promise.all([...connections.all].map((each) => each.flush()));
    return results.every(Boolean);
  }, [connections]);

  const unpersisted = useCallback(
    () => [...connections.all].some((each) => each.pending()),
    [connections],
  );
  const dismissRecovered = useCallback(() => sync?.dismissRecovered(), [sync]);

  return {
    documentId,
    query,
    document: query.data ?? null,
    content,
    sync: editor ? { editor } : null,
    status: sync?.status ?? null,
    error: sync?.error ?? null,
    recovered: sync?.recovered ?? null,
    dismissRecovered,
    flush,
    unpersisted,
  };
}
export type DocumentController = ReturnType<typeof useDocument>;
