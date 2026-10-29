import { readDesktopAppUse, type AppUseUpdate, type DesktopAppUse } from "@chat/desktop-rpc";
import { useCallback, useSyncExternalStore } from "react";

const subscribeToNothing = () => () => {};

/** The shell's live view of app use, or null in a web browser, off macOS and Windows and in older shells. */
export function useDesktopAppUse(): DesktopAppUse | null {
  return useSyncExternalStore(subscribeToNothing, readDesktopAppUse, () => null);
}

/**
 * Each chat's view as the shell last told it, kept once for the page however many parts draw
 * it: a tab's owner, bar and stage would otherwise each decode every picture. Null until the
 * shell says the chat has used an app here.
 */
const views = new Map<string, AppUseUpdate | null>();
const listeners = new Map<string, Set<() => void>>();
let heard: (() => void) | null = null;
let heardFrom: DesktopAppUse | null = null;

/**
 * Per chat, the last spell of app use whose tab opened, and the last whose tab the person
 * closed. Kept for the page's life, so coming back to a chat neither opens its tab again nor
 * brings back one the person closed.
 */
export const appViewSpells = {
  opened: new Map<string, number>(),
  closed: new Map<string, number>(),
};

/**
 * For tests, which share one page: start it over, with no views, spells or subscription. A
 * real page never needs to, since a change of identity replaces the whole document.
 */
export function forgetAppViews() {
  heard?.();
  heard = null;
  heardFrom = null;
  views.clear();
  listeners.clear();
  appViewSpells.opened.clear();
  appViewSpells.closed.clear();
}

const notify = (conversationId: string) => {
  for (const listener of listeners.get(conversationId) ?? []) listener();
};

function subscribe(appUse: DesktopAppUse, conversationId: string, listener: () => void) {
  if (heardFrom !== appUse) {
    heard?.();
    heardFrom = appUse;
    heard = appUse.onUpdate((update) => {
      views.set(update.conversationId, update);
      notify(update.conversationId);
    });
  }
  const chat = listeners.get(conversationId) ?? new Set();
  listeners.set(conversationId, chat);
  chat.add(listener);
  if (!views.has(conversationId)) {
    // What it was before this page listened, unless an update has said more since.
    views.set(conversationId, null);
    void appUse.state(conversationId).then(
      (update) => {
        if (!update || views.get(conversationId) !== null) return;
        views.set(conversationId, update);
        notify(conversationId);
      },
      () => {},
    );
  }
  return () => {
    chat.delete(listener);
  };
}

/** A chat's app use as the shell last told it: null before the chat used an app here. */
export function useAppView(conversationId: string): AppUseUpdate | null {
  const appUse = useDesktopAppUse();
  const subscribeToChat = useCallback(
    (listener: () => void) =>
      appUse ? subscribe(appUse, conversationId, listener) : subscribeToNothing(),
    [appUse, conversationId],
  );
  return useSyncExternalStore(
    subscribeToChat,
    () => (appUse ? (views.get(conversationId) ?? null) : null),
    () => null,
  );
}
