import { useQueryClient } from "@tanstack/react-query";
import { announceSignIn } from "~/modules/integrations/client/sign-in-channel.ts";
import { bringToTop, markGenerating } from "~/modules/chat/client/conversation-list-cache.ts";
import { useEffect } from "react";
import { announceTicketRedeemed } from "~/modules/auth/ticket-events.ts";
import { discardWorkspace } from "~/modules/desktop/client/bridge.ts";
import { showNotification } from "~/modules/notifications/client/show.ts";
import type { SyncEvent } from "../events.ts";
import { takeSyncFeed } from "./feed.ts";

type DomainEvent = Exclude<SyncEvent, { type: "sync.ready" }>;

/** How long the message events of one turn are gathered into one chat refetch. */
const CONVERSATION_BURST_MS = 120;

/**
 * Events after which a person may store more or less: an answer's files, a file taken out, a
 * purge, project files, skills. Indexing and document edits are left out: they come in bursts
 * and store nothing new, and uploads are caught by the page refetching when shown.
 */
const STORAGE_EVENTS: ReadonlySet<string> = new Set([
  "message.status",
  "conversation.updated",
  "conversation.deleted",
  "conversation.purged",
  "project.changed",
  "resources.changed",
]);

// Prefixes owned by the routing below. Knowledge and work use their coalesced refreshes.
const recoveryPrefixes = [
  ["conversations"],
  ["conversation"],
  ["memory"],
  ["sidebar"],
  ["documents"],
  ["projects"],
  ["agents"],
  ["skills"],
  ["custom-tools"],
  ["schedules"],
  ["schedule"],
  ["schedule-runs"],
  ["sharing"],
  ["admin", "groups"],
  ["admin", "group-members"],
  ["admin", "group-capabilities"],
  ["admin", "default-capabilities"],
  ["capabilities"],
  ["chat-models"],
  ["image-models"],
  ["admin", "models"],
  ["drafts"],
  ["integrations"],
  ["admin", "integrations"],
  ["integration-approvals"],
  ["desktop-sessions"],
  ["search", "recent-chats"],
  ["search", "chats"],
  ["my-storage"],
] as const;

/**
 * One SSE connection per tab. Applies this user's domain events (from any
 * browser/instance) to the query cache so sidebar and open chats stay in sync.
 */
export function useSync(
  reconcileIdentity?: () => Promise<boolean>,
  /** Where a clicked notification goes; a full load without a router. */
  openPath?: (path: string) => void,
) {
  const queryClient = useQueryClient();

  useEffect(() => {
    // The app route opens the feed before its loaders read; see feed.ts.
    const feed = takeSyncFeed();
    const source = feed?.source ?? new EventSource("/api/sync");
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
    // A turn announces both of its rows and the answer's status within a few
    // milliseconds, and each refetch is the chat's whole visible window. The chat
    // goes stale at once and refetches once per burst.
    const conversationRefreshes = new Map<string, ReturnType<typeof setTimeout>>();
    const refreshConversation = (conversationId: string) => {
      const queryKey = ["conversation", conversationId];
      void queryClient.invalidateQueries({ queryKey, refetchType: "none" });
      if (conversationRefreshes.has(conversationId)) return;
      conversationRefreshes.set(
        conversationId,
        setTimeout(() => {
          conversationRefreshes.delete(conversationId);
          // Not only if still stale: a fetch that started before these events
          // would clear the mark when it lands. Refetching replaces that fetch.
          void queryClient.refetchQueries({ queryKey, type: "active" });
        }, CONVERSATION_BURST_MS),
      );
    };

    // Events that arrive while identity is being checked, applied once it holds.
    let held: DomainEvent[] = [];
    let connection = 0;
    let identityRetry: ReturnType<typeof setTimeout> | undefined;
    let workRefreshing = false;
    let workDirty = false;
    const refreshWork = () => {
      if (disposed || !authorized) return;
      if (workRefreshing) {
        workDirty = true;
        return;
      }
      workRefreshing = true;
      workDirty = queryClient.isFetching({ queryKey: ["desktop-work"] }) > 0;
      void queryClient
        .invalidateQueries({ queryKey: ["desktop-work"] }, { cancelRefetch: false })
        .finally(() => {
          workRefreshing = false;
          if (workDirty && !disposed && authorized) refreshWork();
        });
    };
    const onError = () => {
      authorized = false;
      held = [];
      connection += 1;
      clearTimeout(identityRetry);
      clearKnowledgeTimer();
    };
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
      refreshWork();
      const pending = held;
      held = [];
      // A tree that read before subscribing can have missed anything, and so can
      // a reconnect. A feed subscribed before the reads only missed what it held.
      if (opened || (reconcileIdentity && !feed?.subscribedBeforeReads)) {
        for (const queryKey of recoveryPrefixes) {
          void queryClient.invalidateQueries({ queryKey });
        }
      } else for (const event of pending) apply(event);
      opened = true;
    };
    const onOpen = () => {
      authorized = false;
      clearTimeout(identityRetry);
      clearKnowledgeTimer();
      connection += 1;
      void open(connection);
    };

    const onSync = (data: string) => {
      if (disposed) return;
      const event = JSON.parse(data) as SyncEvent;
      if (event.type === "sync.ready") {
        clearTimeout(identityRetry);
        clearKnowledgeTimer();
        connection += 1;
        void open(connection);
        return;
      }
      if (authorized) apply(event);
      else held.push(event);
    };

    function apply(event: DomainEvent) {
      // What the person stores moves with these; only an open Storage page refetches.
      if (
        STORAGE_EVENTS.has(event.type) &&
        !(event.type === "message.status" && event.status === "streaming")
      )
        void queryClient.invalidateQueries({ queryKey: ["my-storage"] });
      switch (event.type) {
        case "account.approval.changed":
          void reconcileIdentity?.();
          break;
        case "desktop.work.changed":
          refreshWork();
          break;
        case "draft.changed":
          void queryClient.invalidateQueries({ queryKey: ["drafts", event.kind, event.draftId] });
          // A tool can create the draft after this chat’s loader snapshot.
          void queryClient.invalidateQueries({ queryKey: ["conversation", event.conversationId] });
          break;
        case "schedule.changed":
          void queryClient.invalidateQueries({ queryKey: ["schedules"] });
          void queryClient.invalidateQueries({ queryKey: ["schedule", event.scheduleId] });
          break;
        case "schedule.run.changed":
          void queryClient.invalidateQueries({ queryKey: ["schedule-runs", event.scheduleId] });
          void queryClient.invalidateQueries({ queryKey: ["schedule", event.scheduleId] });
          break;
        case "document.changed":
          void queryClient.invalidateQueries({ queryKey: ["documents", event.documentId] });
          if (event.conversationId) {
            void queryClient.invalidateQueries({
              queryKey: ["documents", "list", event.conversationId],
            });
            // Creation, rename and deletion change the loader's summary list;
            // typing does not, and would otherwise reload the chat once a second.
            if (!event.textOnly)
              void queryClient.invalidateQueries({
                queryKey: ["conversation", event.conversationId],
              });
          }
          if (event.projectId)
            void queryClient.invalidateQueries({
              queryKey: ["projects", "documents", event.projectId],
            });
          break;
        case "project.changed":
          void queryClient.invalidateQueries({ queryKey: ["projects"] });
          // A chat's project, its instructions and its documents all come with the detail.
          void queryClient.invalidateQueries({ queryKey: ["conversation"] });
          break;
        case "conversation.created":
        case "conversation.updated":
        case "conversation.deleted":
        case "conversation.purged":
          // Not at the delete itself: Undo would find a work chat's folder gone.
          if (event.type === "conversation.purged") discardWorkspace(event.conversationId);
          refreshWork();
          void queryClient.invalidateQueries({ queryKey: ["conversations"] });
          // A project's chat list is the same rows, filtered by project.
          void queryClient.invalidateQueries({ queryKey: ["projects", "chats"] });
          // And the palette's recent chats and chat search, cached apart.
          void queryClient.invalidateQueries({ queryKey: ["search", "recent-chats"] });
          void queryClient.invalidateQueries({ queryKey: ["search", "chats"] });
          if (event.type !== "conversation.created") {
            // Prefix, not this id alone: a branch's detail embeds its source's
            // title, so renaming or deleting one conversation can stale
            // another's. Only active queries refetch, and these events fire
            // per rename/title/delete, not per token.
            void queryClient.invalidateQueries({ queryKey: ["conversation"] });
            // Saved memories embed source titles and whether the source still
            // exists, so rename/delete events must refresh their provenance.
            void queryClient.invalidateQueries({ queryKey: ["memory"] });
            // A schedule's run history links each run's chat only while it opens.
            void queryClient.invalidateQueries({ queryKey: ["schedule-runs"] });
          }
          break;
        case "conversation.queue.changed":
          // The work snapshot lists Work chats with a queued message ready, so
          // a desktop app learns of one queued behind an answer that just ended.
          refreshWork();
          void queryClient.invalidateQueries({ queryKey: ["conversation", event.conversationId] });
          break;
        case "message.created":
        case "message.status":
          refreshWork();
          refreshConversation(event.conversationId);
          // The event carries what the lists show, so they are patched, not re-paged.
          if (event.type === "message.created") bringToTop(queryClient, event.conversationId);
          else markGenerating(queryClient, event.conversationId, event.status === "streaming");
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
          void queryClient.invalidateQueries({ queryKey: ["image-models"] });
          void queryClient.invalidateQueries({ queryKey: ["admin", "models"] });
          void queryClient.invalidateQueries({ queryKey: ["admin", "groups"] });
          void queryClient.invalidateQueries({ queryKey: ["admin", "group-members"] });
          void queryClient.invalidateQueries({ queryKey: ["admin", "group-capabilities"] });
          void queryClient.invalidateQueries({ queryKey: ["admin", "default-capabilities"] });
          void queryClient.invalidateQueries({ queryKey: ["capabilities"] });
          void queryClient.invalidateQueries({ queryKey: ["sharing"] });
          refreshKnowledge();
          void queryClient.invalidateQueries({ queryKey: ["agents"] });
          void queryClient.invalidateQueries({ queryKey: ["skills"] });
          void queryClient.invalidateQueries({ queryKey: ["custom-tools"] });
          void queryClient.invalidateQueries({ queryKey: ["schedules"] });
          void queryClient.invalidateQueries({ queryKey: ["schedule"] });
          void queryClient.invalidateQueries({ queryKey: ["schedule-runs"] });
          void queryClient.invalidateQueries({ queryKey: ["documents"] });
          void queryClient.invalidateQueries({ queryKey: ["projects"] });
          void queryClient.invalidateQueries({ queryKey: ["memory"] });
          void queryClient.invalidateQueries({ queryKey: ["integrations"] });
          break;
        case "models.defaults.changed":
          void queryClient.invalidateQueries({ queryKey: ["chat-models"] });
          void queryClient.invalidateQueries({ queryKey: ["image-models"] });
          void queryClient.invalidateQueries({ queryKey: ["admin", "models"] });
          break;
        case "integrations.changed":
          void queryClient.invalidateQueries({ queryKey: ["integrations"] });
          void queryClient.invalidateQueries({ queryKey: ["admin", "integrations"] });
          break;
        case "integration.signIn.failed":
          announceSignIn({ attempt: event.attempt, error: event.error });
          break;
        case "integration.approval.changed":
          void queryClient.invalidateQueries({ queryKey: ["integration-approvals"] });
          break;
        case "memory.changed":
        case "memory.policy.changed":
          void queryClient.invalidateQueries({ queryKey: ["memory"] });
          break;
        case "sidebar.changed":
          void queryClient.invalidateQueries({ queryKey: ["sidebar"] });
          break;
        case "desktop.session.created":
          void queryClient.invalidateQueries({ queryKey: ["desktop-sessions"] });
          announceTicketRedeemed(event.ticketId);
          break;
        case "notification":
          showNotification(
            event.notification,
            openPath ?? ((path) => window.location.assign(path)),
          );
          break;
      }
    }

    source.addEventListener("error", onError);
    source.addEventListener("open", onOpen);
    source.addEventListener("sync", (raw) => onSync((raw as MessageEvent).data));
    for (const frame of feed?.backlog ?? []) {
      if (frame.type === "error") onError();
      else if (frame.type === "open") onOpen();
      else onSync(frame.data);
    }

    return () => {
      disposed = true;
      for (const timer of conversationRefreshes.values()) clearTimeout(timer);
      clearTimeout(identityRetry);
      clearKnowledgeTimer();
      source.close();
    };
  }, [queryClient, reconcileIdentity, openPath]);
}
