import { useSyncExternalStore } from "react";

// Nothing to subscribe to: the value flips exactly once, when React swaps the
// server snapshot for the client one at the end of hydration.
const subscribe = () => () => {};
const onClient = () => true;
const onServer = () => false;

/**
 * False while rendering on the server and during the hydrating render, true
 * afterwards. Anything derived from the visitor's clock or timezone has to
 * wait for it — the server formats in its own zone, so rendering it eagerly
 * hydrates into a mismatch.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, onClient, onServer);
}
