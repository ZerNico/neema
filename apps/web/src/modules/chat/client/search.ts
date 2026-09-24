import { BubbleChatIcon } from "@hugeicons/core-free-icons";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { SearchSource } from "~/modules/search/registry.ts";
import { MIN_SEARCH_LENGTH } from "~/modules/search/text.ts";
import { useDebounced } from "~/ui/use-debounced.ts";
import { listConversations, searchChats } from "../server/functions.ts";

const RECENT_CHATS = 5;
/** Local sources answer per keystroke; this one waits for a pause in typing. */
const SEARCH_DELAY_MS = 150;

const chatHref = (conversationId: string) => `/chat/${conversationId}`;

/** Recent chats before anything is typed, then titles and message text from the server. */
export const useChatSearch: SearchSource = (query, active) => {
  const settled = useDebounced(query, SEARCH_DELAY_MS);
  const searching = settled.length >= MIN_SEARCH_LENGTH;
  const recent = useQuery({
    queryKey: ["search", "recent-chats"],
    queryFn: () => listConversations({ data: { limit: RECENT_CHATS } }),
    enabled: active && !query,
    staleTime: 10_000,
  });
  const found = useQuery({
    queryKey: ["search", "chats", settled],
    queryFn: () => searchChats({ data: { query: settled } }),
    enabled: active && searching,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const empty = { heading: "Chats", kind: "result" as const, items: [], pending: false };
  if (!active) return empty;
  if (!query)
    return {
      ...empty,
      heading: "Recent chats",
      items: (recent.data?.conversations ?? []).map((chat) => ({
        id: `chat:${chat.id}`,
        label: chat.title ?? "New chat",
        icon: BubbleChatIcon,
        href: chatHref(chat.id),
      })),
      pending: recent.isPending,
    };
  if (query.length < MIN_SEARCH_LENGTH) return empty;
  return {
    ...empty,
    items: (found.data ?? []).map((hit) => ({
      id: `chat:${hit.conversationId}`,
      label: hit.title ?? "New chat",
      snippet: hit.snippet,
      icon: BubbleChatIcon,
      href: chatHref(hit.conversationId),
    })),
    pending: query !== settled || found.isFetching,
  };
};
