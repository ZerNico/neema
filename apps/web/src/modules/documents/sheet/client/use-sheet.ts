import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { SheetChange } from "@chat/sheet/model/ops";
import { deviceCache } from "~/modules/cache/client/device-cache.ts";
import { pushSheet } from "../server/sheet-functions.ts";
import { SheetSync, type SheetOutbox, type SheetState } from "./sheet-sync.ts";

const store = deviceCache<{ change: SheetChange; savedAt: number }>({
  namespace: "sheet-unsent",
  // Unsent edits, not a cache: never evicted, whatever their size.
  keep: true,
  maxBytes: 16 * 1024 * 1024,
});
/** The prefix of a sheet's changes, or of one client's among them. */
const prefixOf = (documentId: string, clientId?: string) =>
  clientId === undefined ? `${documentId}\u0000` : `${documentId}\u0000${clientId}\u0000`;
/**
 * Each unsent change to a sheet, kept on this device under its own key (the
 * sheet, its client and its number), so no tab overwrites another's.
 */
const sheetOutbox: SheetOutbox = {
  load: async (documentId) => {
    await store.warm();
    const entries = await store.reloadAll(prefixOf(documentId));
    return entries
      .map(([, entry]) => entry.change)
      .toSorted((a, b) => a.clientId.localeCompare(b.clientId) || a.seq - b.seq);
  },
  add: (documentId, change) =>
    store.set(`${prefixOf(documentId, change.clientId)}${change.seq}`, {
      change,
      savedAt: Date.now(),
    }),
  forget: (documentId, clientId, seq) => {
    void store.reloadAll(prefixOf(documentId, clientId)).then((entries) => {
      for (const [key, entry] of entries) if (entry.change.seq <= seq) store.delete(key);
    });
  },
};

/**
 * The connections one sheet controller owns: the open one, and any closed
 * one still sending its last changes. An external store, so opening and
 * closing never set state in an effect.
 */
class SheetConnections {
  current: SheetSync | null = null;
  readonly all = new Set<SheetSync>();
  #listeners = new Set<() => void>();
  /** Every connection's changes come through #changed, so a listener follows whichever is open. */
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #changed = () => {
    for (const listener of this.#listeners) listener();
  };
  getState = (): SheetState | null => this.current?.getState() ?? null;
  /** The open connection, or null while none is. */
  sync = () => this.current;
  /** The selection a message names: the sheet, then its anchor's and head's row and column IDs. */
  selected = () => {
    const cursor = this.current?.cursor();
    return cursor
      ? [cursor.sheet, cursor.anchor.r, cursor.anchor.c, cursor.head.r, cursor.head.c]
      : [];
  };
  open(documentId: string) {
    const sync = new SheetSync({
      documentId,
      push: (data) => pushSheet({ data }),
      outbox: sheetOutbox,
    });
    this.all.add(sync);
    this.current = sync;
    const unsubscribe = sync.subscribe(this.#changed);
    this.#changed();
    return () => {
      unsubscribe();
      if (this.current === sync) this.current = null;
      this.#changed();
      void sync.flush().finally(() => {
        this.all.delete(sync);
        sync.destroy();
      });
    };
  }
}

/**
 * What the sheet's body works with. Stable across edits: the body reads the
 * state from the store itself, so an edit and the body's own state changes
 * render together rather than a render apart.
 */
export interface SheetController {
  readonly documentId: string;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getState: () => SheetState | null;
  /** The open connection, or null while none is. */
  readonly sync: () => SheetSync | null;
  readonly flush: () => Promise<boolean>;
  readonly unpersisted: () => boolean;
  readonly selected: () => string[];
}

/**
 * One controller per sheet, mounted beside its document's; only an open
 * sheet holds a connection, and one closing stays until its edits are sent.
 */
export function useSheet(documentId: string, live: boolean) {
  const [connections] = useState(() => new SheetConnections());
  useEffect(
    () => (live ? connections.open(documentId) : undefined),
    [connections, documentId, live],
  );
  const state = useSyncExternalStore(connections.subscribe, connections.getState, () => null);
  const flush = useCallback(async () => {
    const results = await Promise.all([...connections.all].map((each) => each.flush()));
    return results.every(Boolean);
  }, [connections]);
  const unpersisted = useCallback(
    () => [...connections.all].some((each) => each.pending()),
    [connections],
  );
  const controller = useMemo<SheetController>(
    () => ({
      documentId,
      subscribe: connections.subscribe,
      getState: connections.getState,
      sync: connections.sync,
      flush,
      unpersisted,
      selected: connections.selected,
    }),
    [connections, documentId, flush, unpersisted],
  );
  return { controller, state };
}
