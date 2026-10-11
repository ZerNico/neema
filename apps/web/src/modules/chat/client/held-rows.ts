import { type InfiniteData, type QueryClient, type QueryKey } from "@tanstack/react-query";
import type { listConversations } from "../server/functions.ts";

/**
 * Chat rows held out of, or back in, the cached chat lists while an action on
 * them (delete, archive, their Undo) is on its way to the server. A list
 * fetched meanwhile reflects the server from before the action landed, so it
 * is corrected as it arrives, whichever refresh or sync event asked for it.
 */

type ConversationPages = InfiniteData<Awaited<ReturnType<typeof listConversations>>>;
type Row = { id: string };

const isPages = (data: unknown): data is ConversationPages =>
  typeof data === "object" && data !== null && "pages" in data;

const isList = (key: QueryKey) =>
  key[0] === "conversations" || (key[0] === "projects" && key[1] === "chats");

/** Where a held row sat: its query, its page (-1 for a flat list) and its index. */
interface Spot {
  readonly hash: string;
  readonly page: number;
  readonly index: number;
  readonly row: Row;
}

interface Hold {
  readonly spots: Spot[];
  shown: boolean;
}

/** Each client's held rows, and the one cache listener that corrects its fetched lists. */
const holdsByClient = new WeakMap<QueryClient, Map<string, Hold>>();

const withRow = <T extends Row>(rows: T[], spot: Spot): T[] => {
  if (rows.some((row) => row.id === spot.row.id)) return rows;
  const next = [...rows];
  next.splice(Math.min(spot.index, rows.length), 0, spot.row as T);
  return next;
};

const without = (data: unknown, id: string): unknown => {
  const keep = (row: Row) => row.id !== id;
  if (isPages(data)) {
    if (!data.pages.some((page) => page.conversations.some((row) => row.id === id))) return data;
    return {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        conversations: page.conversations.filter(keep),
      })),
    };
  }
  // A flat list: the archived chats, a project's chats.
  if (Array.isArray(data) && data.some((row: Row) => row.id === id)) return data.filter(keep);
  return data;
};

/** Reinserts the row where it sat, into the list as it is now; a missing page is left to the refetch. */
const restored = (data: unknown, spot: Spot): unknown => {
  if (spot.page === -1) return Array.isArray(data) ? withRow<Row>(data, spot) : data;
  if (!isPages(data)) return data;
  if (data.pages.some((page) => page.conversations.some((row) => row.id === spot.row.id)))
    return data;
  const page = data.pages[spot.page];
  if (!page) return data;
  return {
    ...data,
    pages: data.pages.map((each, index) =>
      index === spot.page ? { ...each, conversations: withRow(page.conversations, spot) } : each,
    ),
  };
};

const corrected = (rows: Map<string, Hold>, hash: string, data: unknown) => {
  let next = data;
  for (const [id, hold] of rows) {
    if (!hold.shown) next = without(next, id);
    else for (const spot of hold.spots) if (spot.hash === hash) next = restored(next, spot);
  }
  return next;
};

const holdsFor = (queryClient: QueryClient) => {
  const existing = holdsByClient.get(queryClient);
  if (existing) return existing;
  const rows = new Map<string, Hold>();
  queryClient.getQueryCache().subscribe((event) => {
    // A fetched list only: our own writes are `manual`, and correcting them again would loop.
    if (event.type !== "updated" || event.action.type !== "success" || event.action.manual) return;
    if (!isList(event.query.queryKey)) return;
    const data = event.query.state.data;
    const next = corrected(rows, event.query.queryHash, data);
    if (next !== data) queryClient.setQueryData(event.query.queryKey, next);
  });
  holdsByClient.set(queryClient, rows);
  return rows;
};

/**
 * Takes a chat out of every cached list at once and keeps it out until
 * released. `show` puts it back where it sat, into the lists as they are by
 * then, and keeps it there until released, so a second delete or any newer
 * change survives an Undo of the first. Release once the server has the
 * outcome, before the refresh that reads it.
 */
export const holdRow = async (queryClient: QueryClient, conversationId: string) => {
  const filter = { predicate: (query: { queryKey: QueryKey }) => isList(query.queryKey) };
  // A list fetch already under way is corrected on arrival, but need not run.
  await queryClient.cancelQueries(filter);
  const spots: Spot[] = [];
  for (const query of queryClient.getQueryCache().findAll(filter)) {
    const data = query.state.data;
    const hash = query.queryHash;
    if (isPages(data))
      data.pages.forEach((page, pageIndex) => {
        const index = page.conversations.findIndex((row) => row.id === conversationId);
        const row = page.conversations[index];
        if (row) spots.push({ hash, page: pageIndex, index, row });
      });
    else if (Array.isArray(data)) {
      const rows: Row[] = data;
      const index = rows.findIndex((row) => row.id === conversationId);
      const row = rows[index];
      if (row) spots.push({ hash, page: -1, index, row });
    }
  }
  const holds = holdsFor(queryClient);
  const hold: Hold = { spots, shown: false };
  holds.set(conversationId, hold);
  const rewrite = (change: (hash: string, data: unknown) => unknown) => {
    for (const query of queryClient.getQueryCache().findAll(filter)) {
      const data = query.state.data;
      const next = change(query.queryHash, data);
      if (next !== data) queryClient.setQueryData(query.queryKey, next);
    }
  };
  rewrite((_, data) => without(data, conversationId));
  return {
    show: () => {
      hold.shown = true;
      rewrite((hash, data) =>
        hold.spots.reduce((next, spot) => (spot.hash === hash ? restored(next, spot) : next), data),
      );
    },
    // Only this hold's own: a newer action on the same chat holds it anew.
    release: () => {
      if (holds.get(conversationId) === hold) holds.delete(conversationId);
    },
  };
};

const lanes = new Map<string, Promise<unknown>>();

/**
 * Runs server actions on one chat in the order they were asked for, so an
 * Undo still on its way cannot land after the delete that followed it.
 */
export const inLane = <T>(conversationId: string, run: () => Promise<T>): Promise<T> => {
  const next = (lanes.get(conversationId) ?? Promise.resolve()).then(run, run);
  const tail = next.catch(() => undefined);
  lanes.set(conversationId, tail);
  void tail.then(() => {
    if (lanes.get(conversationId) === tail) lanes.delete(conversationId);
  });
  return next;
};
