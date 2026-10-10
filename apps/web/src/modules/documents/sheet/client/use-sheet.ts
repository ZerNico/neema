import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { pushSheet } from "../server/sheet-functions.ts";
import { SheetSync, type SheetState } from "./sheet-sync.ts";

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
    const sync = new SheetSync({ documentId, push: (data) => pushSheet({ data }) });
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
