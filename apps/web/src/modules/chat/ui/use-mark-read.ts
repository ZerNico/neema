import { useEffect } from "react";
import { markConversationRead } from "../server/functions.ts";

/**
 * Clears a run's unread mark once the chat is actually on screen: a tab left
 * open on it in the background has not been read.
 */
export function useMarkRead(conversationId: string, unread: boolean) {
  useEffect(() => {
    if (!unread) return;
    const mark = () => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", mark);
      markConversationRead({ data: { conversationId } }).catch((error: unknown) =>
        console.error("Could not mark the chat read", error),
      );
    };
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [conversationId, unread]);
}
