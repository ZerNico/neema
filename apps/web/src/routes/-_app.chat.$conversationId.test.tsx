import { QueryClient } from "@tanstack/react-query";
import { isNotFound, notFound } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "./_app.chat.$conversationId.tsx";
import { Route as NewChatRoute } from "./_app.index.tsx";
import { getConversationWithMessages, listChatModels } from "~/modules/chat/server/functions.ts";
import { getWebSearchAvailability } from "~/modules/tools/server/functions.ts";

vi.mock("~/modules/chat/server/functions.ts", () => ({
  getConversationWithMessages: vi.fn(),
  listChatModels: vi.fn(),
  listConversations: vi.fn(),
}));
vi.mock("~/modules/tools/server/functions.ts", () => ({
  getWebSearchAvailability: vi.fn(),
}));
// The views are covered by chat-view.test; the routes only have to hand them data.
vi.mock("~/modules/chat/ui/chat-view.tsx", () => ({
  ChatView: () => <div />,
  NewChatView: () => <div />,
}));

const conversationMock = vi.mocked(getConversationWithMessages);
const modelsMock = vi.mocked(listChatModels);
const availabilityMock = vi.mocked(getWebSearchAvailability);
const availability = { configured: true, enabled: true };

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const runLoader = (queryClient: QueryClient, route: typeof Route | typeof NewChatRoute = Route) =>
  // Only the fields the loaders read; the router supplies the rest.
  (
    route.options.loader as (args: {
      context: { queryClient: QueryClient };
      params: { conversationId: string };
      abortController: AbortController;
    }) => Promise<undefined>
  )({
    context: { queryClient },
    params: { conversationId: "c1" },
    abortController: new AbortController(),
  });

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(() => {
  vi.resetAllMocks();
  conversationMock.mockResolvedValue({ conversation: { id: "c1" }, messages: [] } as never);
  modelsMock.mockResolvedValue([]);
  availabilityMock.mockResolvedValue(availability);
});

describe.each([
  { name: "existing chat", route: Route },
  { name: "new chat", route: NewChatRoute },
])("$name route composer loading", ({ route }) => {
  it("starts requests together and waits for composer data before rendering", async () => {
    const conversation = deferred<unknown>();
    const models = deferred<unknown>();
    const search = deferred<typeof availability>();
    conversationMock.mockReturnValue(conversation.promise as never);
    modelsMock.mockReturnValue(models.promise as never);
    availabilityMock.mockReturnValue(search.promise);
    const queryClient = newClient();

    const pending = runLoader(queryClient, route);
    // None has answered yet: a serial loader would only have started one.
    expect(modelsMock).toHaveBeenCalledTimes(1);
    expect(availabilityMock).toHaveBeenCalledTimes(1);
    if (route === Route) {
      expect(conversationMock).toHaveBeenCalledWith({ data: { conversationId: "c1" } });
    } else {
      expect(conversationMock).not.toHaveBeenCalled();
    }

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    conversation.resolve({ conversation: { id: "c1" }, messages: [] });
    models.resolve([]);
    await waitFor(() => expect(queryClient.getQueryData(["chat-models"])).toEqual([]));
    expect(settled).toBe(false);

    search.resolve(availability);
    // The SSR query integration serializes the cache; don't duplicate the payload.
    await expect(pending).resolves.toBeUndefined();
    expect(queryClient.getQueryData(["tools", "web-search", "availability"])).toEqual(availability);
    if (route === Route) {
      expect(queryClient.getQueryData(["conversation", "c1"])).toEqual({
        conversation: { id: "c1" },
        messages: [],
      });
    }
  });

  it("reuses fresh cached data instead of refetching", async () => {
    const queryClient = newClient();
    await runLoader(queryClient, route);
    await runLoader(queryClient, route);

    expect(modelsMock).toHaveBeenCalledTimes(1);
    expect(availabilityMock).toHaveBeenCalledTimes(1);
    expect(conversationMock).toHaveBeenCalledTimes(route === Route ? 1 : 0);
  });

  it("does not prevent opening a chat if optional search config fails", async () => {
    availabilityMock.mockRejectedValue(new Error("Search config unavailable"));
    const queryClient = newClient();

    await expect(runLoader(queryClient, route)).resolves.toBeUndefined();
    expect(availabilityMock).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(["chat-models"])).toEqual([]);
    expect(queryClient.getQueryState(["tools", "web-search", "availability"])?.status).toBe(
      "error",
    );
  });

  it("still rejects a failed required model lookup", async () => {
    modelsMock.mockRejectedValue(new Error("Models unavailable"));
    await expect(runLoader(newClient(), route)).rejects.toThrow("Models unavailable");
  });
});

describe("chat route loader", () => {
  it("opens Work in a browser without creating a local folder query", async () => {
    conversationMock.mockResolvedValue({
      conversation: { id: "c1", mode: "work" },
      messages: [],
    } as never);
    const queryClient = newClient();
    await runLoader(queryClient);
    expect(queryClient.getQueryState(["desktop-folder", "c1"])).toBeUndefined();
  });

  it("preserves a missing server conversation as route not-found", async () => {
    conversationMock.mockRejectedValue(notFound());
    await expect(runLoader(newClient())).rejects.toSatisfy(isNotFound);
  });

  it("rejects malformed missing-conversation data before rendering the view", async () => {
    conversationMock.mockResolvedValue({ conversation: undefined, messages: [] } as never);
    await expect(runLoader(newClient())).rejects.toSatisfy(isNotFound);
  });
});

it.each(["server", "browser", "outdated"])(
  "skips folder preparation on %s before touching the cache",
  async (environment) => {
    vi.resetModules();
    const { prepareWorkFolder } = await import("~/modules/desktop/client/bridge.ts");
    const request = vi.fn();
    const queryClient = newClient();
    if (environment === "server") vi.stubGlobal("window", undefined);
    else
      vi.stubGlobal(
        "__chatDesktop",
        environment === "browser" ? undefined : { protocolVersion: -1, request },
      );
    try {
      await prepareWorkFolder(queryClient, "c1", new AbortController().signal);
      expect(request).not.toHaveBeenCalled();
      expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
      queryClient.clear();
    }
  },
);

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
