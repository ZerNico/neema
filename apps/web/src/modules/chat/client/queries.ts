import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import {
  getConversationHistory,
  getConversationWithMessages,
  listArchivedConversations,
  listChatModels,
  listConversations,
} from "../server/functions.ts";
import { getComposerAvailability } from "~/modules/tools/server/functions.ts";

export const CONVERSATIONS_PAGE_SIZE = 30;

/** Opaque to the client, handed straight back to the server next page. */
export interface ConversationCursorValue {
  activity: string;
  id: string;
}

/**
 * Keyed under the existing `["conversations"]` prefix so the sync bus's
 * prefix invalidation still covers every search variant.
 */
export const conversationsInfiniteQuery = (query = "", outsideProjects = false) =>
  infiniteQueryOptions({
    queryKey: ["conversations", { query, outsideProjects }],
    queryFn: ({ pageParam }) =>
      listConversations({
        data: {
          query,
          ...(outsideProjects ? { outsideProjects } : {}),
          limit: CONVERSATIONS_PAGE_SIZE,
          ...(pageParam === null ? {} : { cursor: pageParam }),
        },
      }),
    initialPageParam: null as ConversationCursorValue | null,
    getNextPageParam: (last) => last.nextCursor,
  });

type ConversationDetail = Awaited<ReturnType<typeof getConversationWithMessages>>;

/**
 * The latest turns of a chat and everything conversation-wide. A refetch sends
 * back the first message it already has, so every invalidation grows the
 * loaded range from there instead of sliding it; see `loadConversationDetail`.
 */
export const conversationQuery = (conversationId: string) =>
  queryOptions({
    queryKey: ["conversation", conversationId],
    queryFn: ({ client, queryKey }) => {
      const previous = client.getQueryData<ConversationDetail>(queryKey);
      return getConversationWithMessages({
        data: { conversationId, anchorId: previous?.window.anchorId ?? null },
      });
    },
  });

/**
 * Older pages, newest first, above the head. Keyed by the head's anchor under a
 * root of its own: the sync bus's `["conversation"]` invalidations never refetch
 * them, and a new anchor (a rewind past the old one) leaves them behind.
 */
export const conversationHistoryQuery = (
  conversationId: string,
  anchorId: string | null,
  olderCursor: string | null,
) =>
  infiniteQueryOptions({
    queryKey: ["conversation-history", conversationId, anchorId],
    queryFn: ({ pageParam }) =>
      getConversationHistory({ data: { conversationId, beforeId: pageParam! } }),
    initialPageParam: olderCursor,
    getNextPageParam: (page) => page.olderCursor,
    enabled: olderCursor !== null,
    staleTime: Infinity,
  });

export const chatModelsQuery = queryOptions({
  queryKey: ["chat-models"],
  queryFn: () => listChatModels(),
  staleTime: 60_000,
});

/**
 * What the composer may offer: search, research and PDF parsing. One read,
 * since each composer needs all three and an admin change can move any of
 * them; the tools pages invalidate this key.
 */
export const composerAvailabilityQuery = queryOptions({
  queryKey: ["tools", "availability"],
  queryFn: () => getComposerAvailability(),
  staleTime: 30_000,
});

/**
 * Under the `["conversations"]` prefix, so every archive, unarchive, delete and
 * `conversation.updated` event that refreshes the lists refreshes this too.
 */
export const archivedConversationsQuery = queryOptions({
  queryKey: ["conversations", "archived"],
  queryFn: () => listArchivedConversations(),
});
