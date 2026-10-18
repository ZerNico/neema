import type { InfiniteData, Query, QueryClient } from "@tanstack/react-query";
import type { listConversations } from "../server/functions.ts";

type Page = Awaited<ReturnType<typeof listConversations>>;
type Lists = InfiniteData<Page, unknown>;

// The paged lists only (`["conversations", { query, outsideProjects }]`), not the archived one.
const pagedLists = {
  queryKey: ["conversations"],
  predicate: (query: Query) => typeof query.queryKey[1] === "object" && query.queryKey[1] !== null,
};

/**
 * Flips a listed chat's `generating` flag in place. Refetching instead would
 * re-run every loaded page in turn, since each page's cursor comes from the last.
 */
export function markGenerating(client: QueryClient, conversationId: string, generating: boolean) {
  client.setQueriesData<Lists>(pagedLists, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            conversations: page.conversations.map((row) =>
              row.id === conversationId ? { ...row, generating } : row,
            ),
          })),
        }
      : data,
  );
}

/**
 * A new message puts its chat first. A list that has the row moves it; one
 * that does not keeps only its first page and fetches that alone again.
 */
export function bringToTop(client: QueryClient, conversationId: string) {
  for (const query of client.getQueryCache().findAll(pagedLists)) {
    const data = query.state.data as Lists | undefined;
    if (!data) continue;
    const row = data.pages
      .flatMap((page) => page.conversations)
      .find((candidate) => candidate.id === conversationId);
    if (row) {
      const moved = { ...row, lastMessageAt: new Date() };
      client.setQueryData<Lists>(query.queryKey, {
        ...data,
        pages: data.pages.map((page, index) => {
          const rest = page.conversations.filter((candidate) => candidate.id !== conversationId);
          return { ...page, conversations: index === 0 ? [moved, ...rest] : rest };
        }),
      });
      continue;
    }
    client.setQueryData<Lists>(query.queryKey, {
      pages: data.pages.slice(0, 1),
      pageParams: data.pageParams.slice(0, 1),
    });
    void client.invalidateQueries({ queryKey: query.queryKey, exact: true });
  }
}
