import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { SyncEvent } from "../events.ts";

// One SSE connection per tab. Applies this user's domain events (from any
// browser/instance) to the query cache so sidebar and open chats stay in sync.
export function useSync() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const source = new EventSource("/api/sync");

    source.addEventListener("sync", (raw) => {
      const event = JSON.parse((raw as MessageEvent).data) as SyncEvent;
      switch (event.type) {
        case "conversation.created":
        case "conversation.updated":
        case "conversation.deleted":
          void queryClient.invalidateQueries({ queryKey: ["conversations"] });
          if (event.type !== "conversation.created") {
            void queryClient.invalidateQueries({
              queryKey: ["conversation", event.conversationId],
            });
          }
          break;
        case "message.created":
        case "message.status":
          void queryClient.invalidateQueries({
            queryKey: ["conversation", event.conversationId],
          });
          void queryClient.invalidateQueries({ queryKey: ["conversations"] });
          break;
      }
    });

    return () => source.close();
  }, [queryClient]);
}
