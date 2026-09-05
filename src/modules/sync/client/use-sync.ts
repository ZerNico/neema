import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { SyncEvent } from "../events.ts";

// One SSE connection per tab. Applies this user's domain events (from any
// browser/instance) to the query cache so sidebar and open chats stay in sync.
export function useSync() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const source = new EventSource("/api/sync");

    // Events published while the connection was down are gone for good (the
    // bus is fire-and-forget), so a reconnect refetches everything the feed
    // keeps fresh. Skipped on the initial open: mounting queries are fresh
    // already, and invalidating here would double-fetch every page load.
    let opened = false;
    source.addEventListener("open", () => {
      if (opened) {
        void queryClient.invalidateQueries({ queryKey: ["conversations"] });
        void queryClient.invalidateQueries({ queryKey: ["conversation"] });
        void queryClient.invalidateQueries({ queryKey: ["memory"] });
        void queryClient.invalidateQueries({ queryKey: ["chat-models"] });
        void queryClient.invalidateQueries({ queryKey: ["admin", "models"] });
      }
      opened = true;
    });

    source.addEventListener("sync", (raw) => {
      const event = JSON.parse((raw as MessageEvent).data) as SyncEvent;
      switch (event.type) {
        case "conversation.created":
        case "conversation.updated":
        case "conversation.deleted":
          void queryClient.invalidateQueries({ queryKey: ["conversations"] });
          if (event.type !== "conversation.created") {
            // Prefix, not this id alone: a branch's detail embeds its source's
            // title, so renaming or deleting one conversation can stale
            // another's. Only active queries refetch, and these events fire
            // per rename/title/delete — not per token.
            void queryClient.invalidateQueries({ queryKey: ["conversation"] });
            // Saved memories embed source titles and whether the source still
            // exists, so rename/delete events must refresh their provenance.
            void queryClient.invalidateQueries({ queryKey: ["memory"] });
          }
          break;
        case "message.created":
        case "message.status":
          void queryClient.invalidateQueries({
            queryKey: ["conversation", event.conversationId],
          });
          void queryClient.invalidateQueries({ queryKey: ["conversations"] });
          // Edits are announced as message events; provenance derives whether
          // the saved source content still matches the current message.
          void queryClient.invalidateQueries({ queryKey: ["memory"] });
          break;
        case "models.defaults.changed":
          void queryClient.invalidateQueries({ queryKey: ["chat-models"] });
          void queryClient.invalidateQueries({ queryKey: ["admin", "models"] });
          break;
        case "memory.changed":
        case "memory.policy.changed":
          void queryClient.invalidateQueries({ queryKey: ["memory"] });
          break;
      }
    });

    return () => source.close();
  }, [queryClient]);
}
