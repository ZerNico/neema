import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { SheetChange } from "@chat/sheet/model/ops";
import { deviceCache } from "~/modules/cache/client/device-cache.ts";
import { pushSheet } from "../server/sheet-functions.ts";
import { SheetSync, type SheetOutbox, type SheetState } from "./sheet-sync.ts";

const store = deviceCache<{ changes: SheetChange[]; savedAt: number }>({
  namespace: "sheet-outbox",
  // Unsent edits, not a cache: never evicted, whatever their size.
  keep: true,
  maxBytes: 16 * 1024 * 1024,
});
const keyOf = (documentId: string, clientId: string) => `${documentId}\u0000${clientId}`;
/** Each client's unsent changes to a sheet, kept on this device under the sheet and the client. */
const sheetOutbox: SheetOutbox = {
  load: async (documentId) => {
    await store.warm();
    const entries = await store.reloadAll(keyOf(documentId, ""));
    return entries.flatMap(([, entry]) => entry.changes);
  },
  save: (documentId, clientId, changes) => {
    if (changes.length)
      store.set(keyOf(documentId, clientId), { changes: [...changes], savedAt: Date.now() });
    else store.delete(keyOf(documentId, clientId));
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
  return { documentId, sync: connections.current, state, flush, unpersisted };
}
export type SheetController = ReturnType<typeof useSheet>;
