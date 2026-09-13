import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { SyncEvent } from "../events.ts";

// One SSE connection per tab. Applies this user's domain events (from any
// browser/instance) to the query cache so sidebar and open chats stay in sync.
export function useSync(reconcileIdentity?: () => Promise<boolean>) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const source = new EventSource("/api/sync");
    let knowledgeTimer: ReturnType<typeof setTimeout> | undefined;
    const clearKnowledgeTimer = () => {
      clearTimeout(knowledgeTimer);
      knowledgeTimer = undefined;
    };

    let disposed = false;
    let knowledgeRefreshing = false;
    let knowledgeDirty = false;
    const refreshKnowledge = () => {
      clearKnowledgeTimer();
      if (disposed || !authorized) return;
      if (knowledgeRefreshing) {
        knowledgeDirty = true;
        return;
      }
      knowledgeRefreshing = true;
      // An already-running request may predate this event/subscription. Let it
      // finish without cancellation, then reconcile once more if necessary.
      knowledgeDirty = queryClient.isFetching({ queryKey: ["knowledge"] }) > 0;
      void queryClient
        .invalidateQueries({ queryKey: ["knowledge"] }, { cancelRefetch: false })
        .finally(() => {
          knowledgeRefreshing = false;
          if (knowledgeDirty && !disposed && authorized) queueKnowledge();
        });
    };
    const queueKnowledge = () => {
      if (disposed || !authorized) return;
      knowledgeDirty = true;
      if (!knowledgeRefreshing && knowledgeTimer === undefined)
        knowledgeTimer = setTimeout(refreshKnowledge, 250);
    };

    // Knowledge may finish indexing between its initial fetch and subscription.
    // Reconcile it on first open too; reconnects refresh every feed-backed cache.
    let opened = false;
    let authorized = !reconcileIdentity;
    let connection = 0;
    let identityRetry: ReturnType<typeof setTimeout> | undefined;
    source.addEventListener("error", () => {
      authorized = false;
      connection++;
      clearTimeout(identityRetry);
      clearKnowledgeTimer();
    });
    const open = async (currentConnection: number) => {
      const valid = reconcileIdentity ? await reconcileIdentity().catch(() => false) : true;
      if (disposed || currentConnection !== connection) return;
      if (!valid) {
        identityRetry = setTimeout(() => {
          void open(currentConnection);
        }, 1000);
        return;
      }
      authorized = true;
      refreshKnowledge();
      if (opened || reconcileIdentity) {
        void queryClient.invalidateQueries({ queryKey: ["desktop-work"] });
        void queryClient.invalidateQueries({ queryKey: ["conversations"] });
        void queryClient.invalidateQueries({ queryKey: ["conversation"] });
        void queryClient.invalidateQueries({ queryKey: ["memory"] });
        void queryClient.invalidateQueries({ queryKey: ["agents"] });
        void queryClient.invalidateQueries({ queryKey: ["sharing"] });
        void queryClient.invalidateQueries({ queryKey: ["admin", "groups"] });
        void queryClient.invalidateQueries({ queryKey: ["admin", "group-members"] });
        void queryClient.invalidateQueries({ queryKey: ["chat-models"] });
        void queryClient.invalidateQueries({ queryKey: ["admin", "models"] });
      }
      opened = true;
    };
    source.addEventListener("open", () => {
      authorized = false;
      clearTimeout(identityRetry);
      clearKnowledgeTimer();
      void open(++connection);
    });

    source.addEventListener("sync", (raw) => {
      if (disposed) return;
      const event = JSON.parse((raw as MessageEvent).data) as SyncEvent;
      if (event.type === "sync.ready") {
        clearTimeout(identityRetry);
        clearKnowledgeTimer();
        void open(++connection);
        return;
      }
      if (!authorized) return;
      switch (event.type) {
        case "account.approval.changed":
          void reconcileIdentity?.();
          break;
        case "desktop.work.changed":
          void queryClient.invalidateQueries({ queryKey: ["desktop-work"] });
          break;
        case "agent.draft.changed":
          void queryClient.invalidateQueries({ queryKey: ["agents", "draft", event.draftId] });
          // A tool can create the draft after this chat’s loader snapshot.
          void queryClient.invalidateQueries({ queryKey: ["conversation", event.conversationId] });
          break;
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
        case "knowledge.index.changed":
          // Fixed-window coalescing, with one follow-up after an in-flight fetch.
          queueKnowledge();
          break;
        case "resources.changed":
          void queryClient.invalidateQueries({ queryKey: ["conversation"] });
          clearKnowledgeTimer();
          void queryClient.invalidateQueries({ queryKey: ["chat-models"] });
          void queryClient.invalidateQueries({ queryKey: ["admin", "models"] });
          void queryClient.invalidateQueries({ queryKey: ["admin", "groups"] });
          void queryClient.invalidateQueries({ queryKey: ["admin", "group-members"] });
          void queryClient.invalidateQueries({ queryKey: ["sharing"] });
          refreshKnowledge();
          void queryClient.invalidateQueries({ queryKey: ["agents"] });
          void queryClient.invalidateQueries({ queryKey: ["skills"] });
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

    return () => {
      disposed = true;
      clearTimeout(identityRetry);
      clearKnowledgeTimer();
      source.close();
    };
  }, [queryClient, reconcileIdentity]);
}
