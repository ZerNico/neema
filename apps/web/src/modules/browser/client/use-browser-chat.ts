import { useEffect } from "react";
import { browserTabs } from "./browser-store.ts";

/** Called by the chat view: a temporary chat browses in memory and keeps no tabs. */
export function useBrowserChat(conversationId: string, temporary: boolean) {
  useEffect(() => {
    browserTabs.setTemporary(conversationId, temporary);
  }, [conversationId, temporary]);
}
