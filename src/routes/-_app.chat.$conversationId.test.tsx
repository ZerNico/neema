import { QueryClient } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "./_app.chat.$conversationId.tsx";
import { getConversationWithMessages, listChatModels } from "~/modules/chat/server/functions.ts";

vi.mock("~/modules/chat/server/functions.ts", () => ({
  getConversationWithMessages: vi.fn(),
  listChatModels: vi.fn(),
  listConversations: vi.fn(),
}));
vi.mock("~/modules/tools/server/functions.ts", () => ({
  getWebSearchAvailability: vi.fn(),
}));
// The view is covered by chat-view.test; the route only has to hand it data.
vi.mock("~/modules/chat/ui/chat-view.tsx", () => ({ ChatView: () => <div /> }));

const conversationMock = vi.mocked(getConversationWithMessages);
const modelsMock = vi.mocked(listChatModels);

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const runLoader = (queryClient: QueryClient) =>
  // Only the two fields the loader reads; the router supplies the rest.
  (
    Route.options.loader as (args: {
      context: { queryClient: QueryClient };
      params: { conversationId: string };
    }) => Promise<undefined>
  )({
    context: { queryClient },
    params: { conversationId: "c1" },
  });

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("chat route loader", () => {
  it("starts the conversation and model requests together", async () => {
    const conversation = deferred<unknown>();
    const models = deferred<unknown>();
    conversationMock.mockReturnValue(conversation.promise as never);
    modelsMock.mockReturnValue(models.promise as never);
    const queryClient = newClient();

    const pending = runLoader(queryClient);
    // Neither request has answered yet, so a serial loader would still be
    // waiting on the first one.
    await Promise.resolve();
    expect(conversationMock).toHaveBeenCalledWith({ data: { conversationId: "c1" } });
    expect(modelsMock).toHaveBeenCalledTimes(1);

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    conversation.resolve({ conversation: { id: "c1" }, messages: [] });
    await Promise.resolve();
    expect(settled).toBe(false);

    models.resolve([]);
    // Resolves to nothing: the view reads the cache, and returning the payload
    // would serialize the whole conversation into the SSR document twice.
    await expect(pending).resolves.toBeUndefined();
    expect(queryClient.getQueryData(["conversation", "c1"])).toEqual({
      conversation: { id: "c1" },
      messages: [],
    });
    expect(queryClient.getQueryData(["chat-models"])).toEqual([]);
  });

  it("reuses fresh cached data instead of refetching", async () => {
    conversationMock.mockResolvedValue({ conversation: { id: "c1" }, messages: [] } as never);
    modelsMock.mockResolvedValue([] as never);
    const queryClient = newClient();

    await runLoader(queryClient);
    await runLoader(queryClient);

    expect(conversationMock).toHaveBeenCalledTimes(1);
    expect(modelsMock).toHaveBeenCalledTimes(1);
  });
});

describe("chat route pending state", () => {
  it("waits out a warm open before showing anything", () => {
    expect(Route.options.pendingMs).toBe(200);
    // No floor: it leaves the moment the data lands.
    expect(Route.options.pendingMinMs).toBe(0);
  });

  it("announces the load", () => {
    const Pending = Route.options.pendingComponent!;
    render(<Pending />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByLabelText("Loading conversation")).toBeInTheDocument();
  });
});
