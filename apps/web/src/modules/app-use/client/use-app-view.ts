import { readDesktopAppUse, type AppUseUpdate, type DesktopAppUse } from "@chat/desktop-rpc";
import { useEffect, useState, useSyncExternalStore } from "react";

const subscribeToNothing = () => () => {};

/** The shell's live view of app use, or null in a web browser, off a Mac and in older shells. */
export function useDesktopAppUse(): DesktopAppUse | null {
  return useSyncExternalStore(subscribeToNothing, readDesktopAppUse, () => null);
}

/** A chat's app use as the shell last told it: null before the chat used an app here. */
export function useAppView(conversationId: string): AppUseUpdate | null {
  const appUse = useDesktopAppUse();
  const [view, setView] = useState<AppUseUpdate | null>(null);
  useEffect(() => {
    if (!appUse) return;
    let current = true;
    let heard = false;
    const stop = appUse.onUpdate((update) => {
      if (update.conversationId !== conversationId) return;
      heard = true;
      setView(update);
    });
    // What it was before this page listened, unless an update already said more.
    void appUse.state(conversationId).then(
      (update) => {
        if (current && !heard) setView(update);
      },
      () => {},
    );
    return () => {
      current = false;
      stop();
      setView(null);
    };
  }, [appUse, conversationId]);
  return view?.conversationId === conversationId ? view : null;
}

/**
 * The chat the floating window asked to come back to, until its tab has opened: the chat may
 * not be on screen yet when the ask arrives.
 */
let pendingOpen: string | null = null;
const listeners = new Set<() => void>();

export const appViewOpenRequests = {
  request(conversationId: string) {
    pendingOpen = conversationId;
    for (const listener of listeners) listener();
  },
  /** True once for the chat that was asked for. */
  take(conversationId: string) {
    if (pendingOpen !== conversationId) return false;
    pendingOpen = null;
    return true;
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  get: () => pendingOpen,
};

export function usePendingAppViewOpen() {
  return useSyncExternalStore(appViewOpenRequests.subscribe, appViewOpenRequests.get, () => null);
}
