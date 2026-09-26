import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import {
  getConversationWithMessages,
  listArchivedConversations,
  listChatModels,
  listConversations,
} from "../server/functions.ts";
import {
  getResearchAvailability,
  getWebSearchAvailability,
} from "~/modules/tools/server/functions.ts";

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

export const conversationQuery = (conversationId: string) =>
  queryOptions({
    queryKey: ["conversation", conversationId],
    queryFn: () => getConversationWithMessages({ data: { conversationId } }),
  });

export const chatModelsQuery = queryOptions({
  queryKey: ["chat-models"],
  queryFn: () => listChatModels(),
  staleTime: 60_000,
});

export const researchAvailabilityQuery = queryOptions({
  queryKey: ["tools", "research", "availability"],
  queryFn: () => getResearchAvailability(),
  staleTime: 30_000,
});

export const webSearchAvailabilityQuery = queryOptions({
  queryKey: ["tools", "web-search", "availability"],
  queryFn: () => getWebSearchAvailability(),
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
