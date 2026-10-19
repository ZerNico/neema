import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { HISTORY_LIMITS } from "../history-tool-schema.ts";
import { fitPage, historyActivity, historyText, prepareHistoryTools } from "./history-tools.ts";
import type { HistoryMessage } from "./repo.ts";

const message = (number: number, content: string): HistoryMessage => ({
  number,
  role: number % 2 ? "user" : "assistant",
  createdAt: new Date(Date.UTC(2026, 0, number)),
  content,
});

const call = (group: ReturnType<typeof prepareHistoryTools>, name: string, args: unknown) =>
  Effect.runPromise((group.handlers[name] as (args: unknown) => Effect.Effect<unknown>)(args));

describe("history text", () => {
  it("drops citation markers and keeps a ui block's source behind a note", () => {
    const text = historyText("Paris is big.[^3]\n\n```ui\nconst x = [^1];\n```\nThat is all.[^4]");
    expect(text).toBe(
      "Paris is big.\n\n[Interactive block, shown in the app. Its source follows.]\n```ui\nconst x = [^1];\n```\nThat is all.",
    );
  });
});

describe("a page of history", () => {
  it("fills the budget in order and says where the next page starts", () => {
    const half = "x".repeat(HISTORY_LIMITS.pageChars / 2);
    const page = fitPage([message(3, half), message(4, half), message(5, "next")], 9, "hint");
    expect(page.messages?.map((m) => m.number)).toEqual([3, 4]);
    expect(page).toMatchObject({ from: 3, to: 4, total: 9, nextFrom: 5 });
    expect(fitPage([message(9, "last")], 9, "hint").nextFrom).toBeNull();
  });

  it("cuts a message too long for a page alone and tells how to find the rest", () => {
    const page = fitPage([message(2, "y".repeat(HISTORY_LIMITS.pageChars + 500))], 4, "Search.");
    const text = page.messages?.[0]?.text ?? "";
    expect(text.startsWith("y".repeat(HISTORY_LIMITS.pageChars))).toBe(true);
    expect(text).toContain("500 more characters of message 2 not shown. Search.");
    expect(page.nextFrom).toBe(3);
  });
});

describe("the history tools", () => {
  const page = { messages: [message(1, "Hello"), message(2, "Hi there")], total: 2 };
  const reads: Array<{ conversationId: string; exceptMessageId?: string | undefined }> = [];
  const repo = {
    readHistoryPage: (input: { conversationId: string; exceptMessageId?: string | undefined }) => {
      reads.push(input);
      return Effect.succeed(page);
    },
    searchHistory: () =>
      Effect.succeed({
        hits: [
          { ...message(2, ""), snippet: { text: "Hi there", highlights: [] } },
        ] as never,
        matches: 3,
      }),
    searchConversations: () => Effect.succeed([]),
    findReadableChat: (input: { chatId: string }) =>
      Effect.succeed(input.chatId === "other" ? { id: "other", title: "Trip" } : null),
  };
  const base = { repo: repo as never, userId: "u", conversationId: "c", messageId: "m" };

  it("offers only this chat's history without past chats", () => {
    const group = prepareHistoryTools({ ...base, otherChats: null });
    expect(Object.keys(group.handlers)).toEqual(["read_history"]);
  });

  it("reads this chat without its own answer, and keeps the text out of the row", async () => {
    const group = prepareHistoryTools({ ...base, otherChats: null });
    const result = await call(group, "read_history", { from: "1", count: " 20 " });
    expect(reads.at(-1)).toMatchObject({ conversationId: "c", exceptMessageId: "m" });
    expect(result).toMatchObject({ ok: true, from: 1, to: 2, total: 2, nextFrom: null });
    expect(historyActivity(result)).toEqual({ ok: true, from: 1, to: 2, total: 2 });
  });

  it("refuses a page it cannot read as a number instead of reading another", async () => {
    const group = prepareHistoryTools({ ...base, otherChats: null });
    expect(await call(group, "read_history", { from: "nonsense" })).toMatchObject({ ok: false });
    expect(await call(group, "read_history", { query: "hi", from: 1.5 })).toMatchObject({
      ok: false,
    });
  });

  it("searches this chat and pages past the hits it returned", async () => {
    const group = prepareHistoryTools({ ...base, otherChats: null });
    const result = await call(group, "read_history", { query: " hi " });
    expect(result).toMatchObject({
      ok: true,
      query: "hi",
      matches: 3,
      hits: [{ number: 2, role: "assistant", excerpt: "Hi there" }],
      nextFrom: 3,
    });
    expect(historyActivity(result)).not.toHaveProperty("hits");
  });

  it("reads another chat only when scope finds it", async () => {
    const group = prepareHistoryTools({
      ...base,
      otherChats: { excludeId: "c", projectId: null },
    });
    expect(await call(group, "read_chat", { chatId: "foreign" })).toMatchObject({ ok: false });
    expect(await call(group, "search_chats", {})).toMatchObject({ ok: false });
    const result = await call(group, "read_chat", { chatId: "other" });
    expect(reads.at(-1)).toEqual({ conversationId: "other", from: 1, count: 20 });
    expect(result).toMatchObject({ ok: true, chatId: "other", chatTitle: "Trip" });
  });
});
