import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { sessionUserQuery } from "~/modules/auth/client.ts";
import type { DocumentComment } from "../schema.ts";
import {
  commentOnDocument,
  deleteDocumentComment,
  pushDocument,
  resolveDocumentThread,
} from "../server/document-functions.ts";
import { presenceUser } from "../presence-user.ts";
import { documentQuery } from "./document-queries.ts";
import { selectedBlockIds } from "../editor/block-ids.ts";
import type { DocumentSync } from "./document-sync.ts";

/** This tab's own cursor label; the server replaces it with the signed-in person's. */
const cursorUser = (user: { id: string; name: string } | null | undefined) =>
  presenceUser({ id: user?.id ?? "", name: user?.name ?? "You" });

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

/** A document's comments, and what a reader may do with them. */
export interface DocumentDiscussion {
  /** The reader's account, to tell their own comments apart. */
  me: string | null;
  comments: ReadonlyArray<DocumentComment>;
  /** A new thread when `threadId` is new (with its `quote`), else a reply. */
  comment(
    threadId: string,
    body: string,
    options?: { quote?: string; toAssistant?: boolean },
  ): Promise<void>;
  resolve(threadId: string, resolved: boolean): Promise<void>;
  remove(commentId: string): Promise<void>;
}
const NO_COMMENTS: ReadonlyArray<DocumentComment> = [];

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
  /** The blocks selected in the open editor right now, for the next message to name. */
  selectedBlocks = () => {
    const open = this.current?.editor;
    if (!open) return [];
    const { from, to } = open.state.selection;
    return selectedBlockIds(open.state.doc, from, to);
  };
  /** Connections closed but still storing their last changes, by document. */
  #closing = new Map<string, DocumentSync>();
  open(documentId: string) {
    let closed = false;
    let opened: DocumentSync | null = null;
    let unsubscribe: (() => void) | null = null;
    void (syncFactory ??= loadSync()).then((create) => {
      if (closed) return;
      // Reopened before the last connection finished storing: carry on with it,
      // since a second one would start without its unsent typing.
      const lingering = this.#closing.get(documentId);
      this.#closing.delete(documentId);
      const next = lingering ?? create(documentId);
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
      this.#closing.set(documentId, next);
      void next.flush().finally(() => {
        // Taken up again by a reopen meanwhile: it stays.
        if (this.#closing.get(documentId) !== next) return;
        this.#closing.delete(documentId);
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
  const selectedBlocks = connections.selectedBlocks;
  const comments = sync?.comments ?? NO_COMMENTS;
  const me = user?.id ?? null;
  const discussion = useMemo<DocumentDiscussion>(
    () => ({
      me,
      comments,
      comment: async (threadId, body, options) => {
        await commentOnDocument({
          data: {
            documentId,
            threadId,
            body,
            ...(options?.quote ? { quote: options.quote.slice(0, 500) } : {}),
            ...(options?.toAssistant ? { toAssistant: true } : {}),
          },
        });
      },
      resolve: async (threadId, resolved) => {
        await resolveDocumentThread({ data: { documentId, threadId, resolved } });
      },
      remove: async (commentId) => {
        await deleteDocumentComment({ data: { documentId, commentId } });
      },
    }),
    [comments, documentId, me],
  );

  return {
    documentId,
    query,
    document: query.data ?? null,
    sync: editor ? { editor } : null,
    status: sync?.status ?? null,
    error: sync?.error ?? null,
    recovered: sync?.recovered ?? null,
    dismissRecovered,
    selectedBlocks,
    discussion,
    flush,
    unpersisted,
  };
}
export type DocumentController = ReturnType<typeof useDocument>;
