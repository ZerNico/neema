import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import {
  getConversationWithMessages,
  listChatModels,
  listConversations,
} from "../server/functions.ts";
import { getWebSearchAvailability } from "~/modules/tools/server/functions.ts";

export const CONVERSATIONS_PAGE_SIZE = 30;

/** Opaque to the client — handed straight back to the server next page. */
export interface ConversationCursorValue {
  activity: string;
  id: string;
}

// Keyed under the existing `["conversations"]` prefix so the sync bus's
// prefix invalidation still covers every search variant.
export const conversationsInfiniteQuery = (query = "") =>
  infiniteQueryOptions({
    queryKey: ["conversations", { query }],
    queryFn: ({ pageParam }) =>
      listConversations({
        data: {
          query,
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

export const webSearchAvailabilityQuery = queryOptions({
  queryKey: ["tools", "web-search", "availability"],
  queryFn: () => getWebSearchAvailability(),
  staleTime: 30_000,
});
