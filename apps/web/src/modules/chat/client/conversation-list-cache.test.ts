import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { bringToTop, markGenerating } from "./conversation-list-cache.ts";

type Row = { id: string; generating: boolean; lastMessageAt: Date | null };
type Page = { conversations: Row[]; nextCursor: null | { id: string } };

const row = (id: string): Row => ({ id, generating: false, lastMessageAt: new Date(0) });
const seed = (client: QueryClient, key: unknown[], pages: string[][]) =>
  client.setQueryData<InfiniteData<Page, unknown>>(key, {
    pages: pages.map((ids) => ({ conversations: ids.map(row), nextCursor: null })),
    pageParams: pages.map((_, index) => (index === 0 ? null : { id: `cursor-${index}` })),
  });
const ids = (client: QueryClient, key: unknown[]) =>
  client
    .getQueryData<InfiniteData<Page, unknown>>(key)!
    .pages.map((page) => page.conversations.map((conversation) => conversation.id));
const sidebar = ["conversations", { query: "", outsideProjects: true }];
const search = ["conversations", { query: "plan", outsideProjects: false }];

describe("conversation list cache", () => {
  it("flips one chat's generating flag in every paged list, and leaves the archive alone", () => {
    const client = new QueryClient();
    seed(client, sidebar, [["a", "b"], ["c"]]);
    seed(client, search, [["c"]]);
    client.setQueryData(["conversations", "archived"], ["untouched"]);
    markGenerating(client, "c", true);
    const flags = (key: unknown[]) =>
      client
        .getQueryData<InfiniteData<Page, unknown>>(key)!
        .pages.flatMap((page) => page.conversations.map((r) => [r.id, r.generating]));
    expect(flags(sidebar)).toEqual([
      ["a", false],
      ["b", false],
      ["c", true],
    ]);
    expect(flags(search)).toEqual([["c", true]]);
    expect(client.getQueryData(["conversations", "archived"])).toEqual(["untouched"]);
  });

  it("moves a chat with a new message first without fetching anything", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    seed(client, sidebar, [["a", "b"], ["c", "d"], ["e"]]);
    bringToTop(client, "d");
    expect(ids(client, sidebar)).toEqual([["d", "a", "b"], ["c"], ["e"]]);
    const moved =
      client.getQueryData<InfiniteData<Page, unknown>>(sidebar)!.pages[0]!.conversations[0]!;
    expect(moved.lastMessageAt!.getTime()).toBeGreaterThan(0);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("fetches only the first page again of a list that does not hold the chat", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    seed(client, sidebar, [["a", "b"], ["c"], ["e"]]);
    bringToTop(client, "unseen");
    expect(ids(client, sidebar)).toEqual([["a", "b"]]);
    expect(client.getQueryData<InfiniteData<Page, unknown>>(sidebar)!.pageParams).toEqual([null]);
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: sidebar, exact: true });
  });
});
