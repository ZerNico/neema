import { useSyncExternalStore } from "react";

/**
 * The chat whose live view the floating window sent the person back to, until that chat's tab
 * has opened: the chat may not be on screen yet when the ask arrives.
 */
let pending: string | null = null;
let askedAt = 0;
const listeners = new Set<() => void>();
/** An ask the chat never came on screen for is not acted on at some later visit. */
const EXPIRES_MS = 10_000;

export const appViewOpenRequests = {
  request(conversationId: string) {
    pending = conversationId;
    askedAt = Date.now();
    for (const listener of listeners) listener();
  },
  /** True once, for the chat that was asked for, soon after it was. */
  take(conversationId: string) {
    if (pending !== conversationId) return false;
    pending = null;
    return Date.now() - askedAt < EXPIRES_MS;
  },
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function usePendingAppViewOpen() {
  return useSyncExternalStore(
    subscribe,
    () => pending,
    () => null,
  );
}
