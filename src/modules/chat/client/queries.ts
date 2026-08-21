import { queryOptions } from "@tanstack/react-query";
import {
  getConversationWithMessages,
  listChatModels,
  listConversations,
} from "../server/functions.ts";

export const conversationsQuery = queryOptions({
  queryKey: ["conversations"],
  queryFn: () => listConversations(),
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
