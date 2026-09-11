import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "~/routes/_app.index.tsx";
import { sendMessage } from "../server/functions.ts";
import { uploadAttachment } from "~/modules/attachments/server/functions.ts";

vi.mock("../server/functions.ts", () => ({
  getConversationWithMessages: vi.fn(),
  listConversations: vi.fn(),
  listChatModels: vi.fn(),
  branchConversation: vi.fn(),
  sendMessage: vi.fn(),
  answerQuestion: vi.fn(),
  retryMessage: vi.fn(),
  editMessage: vi.fn(),
  stopGeneration: vi.fn(),
}));
vi.mock("~/modules/tools/server/functions.ts", () => ({
  getWebSearchAvailability: vi.fn(),
  getResearchAvailability: vi.fn(),
}));
vi.mock("~/modules/agents/server/functions.ts", () => ({
  listAgents: vi.fn(),
  getAgent: vi.fn(),
  getAgentSelection: vi.fn(),
}));
vi.mock("~/modules/knowledge/server/functions.ts", () => ({
  listKnowledgeCollections: vi.fn(),
  getKnowledgeCollection: vi.fn(),
}));
vi.mock("~/modules/skills/server/functions.ts", () => ({ listSkills: vi.fn() }));
vi.mock("~/modules/attachments/server/functions.ts", () => ({
  getDocumentParsingAvailability: vi.fn(),
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
}));

let mobile = false;
beforeEach(() => {
  vi.clearAllMocks();
  mobile = false;
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      get matches() {
        return query.includes("max-width") ? mobile : true;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  vi.mocked(sendMessage).mockRejectedValue(new Error("Test send rejected"));
  vi.mocked(uploadAttachment).mockResolvedValue({
    id: "file-1",
    fileName: "notes.txt",
    mediaType: "text/plain",
    kind: "text",
    size: 5,
  });
  URL.createObjectURL = vi.fn(() => "blob:test");
  URL.revokeObjectURL = vi.fn();
});

async function fixture({
  prefill = "Help me create an agent.",
  mount = true,
}: { prefill?: unknown; mount?: boolean } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(
    ["chat-models"],
    [
      {
        id: "normal-default",
        providerId: "provider",
        providerName: "Provider",
        modelKey: "default",
        displayName: "Normal default",
        type: "chat",
        enabled: true,
        isDefault: true,
        contextLength: 128_000,
        capabilities: { tools: true, reasoning: false, vision: false, files: false },
      },
    ],
  );
  client.setQueryData(["agents", "list"], []);
  client.setQueryData(["knowledge", "collections"], []);
  client.setQueryData(["skills"], []);
  for (const name of ["web-search", "research", "document-parsing"])
    client.setQueryData(["tools", name, "availability"], { configured: false, enabled: false });
  const root = createRootRouteWithContext<{ queryClient: QueryClient; user: { name: string } }>()();
  const app = createRoute({ getParentRoute: () => root, id: "_app" });
  // Use the real file-route component and search validator under its real route ID.
  const home = createRoute({
    getParentRoute: () => app,
    path: "/",
    component: Route.options.component!,
    validateSearch: Route.options.validateSearch!,
  });
  const agents = createRoute({
    getParentRoute: () => app,
    path: "/agents",
    component: () => <p>Agents destination</p>,
  });
  const history = createMemoryHistory({ initialEntries: ["/agents"] });
  history.push("/", {
    ...(prefill === null ? {} : { chatPrefill: prefill }),
    retained: { value: "keep me" },
    __hashScrollIntoViewOptions: false,
  });
  const router = createRouter({
    routeTree: root.addChildren([app.addChildren([home, agents])]),
    history,
    context: { queryClient: client, user: { name: "Nico" } },
  });
  await router.load();
  const tree = (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  const view = mount ? render(tree) : null;
  return { router, history, tree, view };
}

describe("one-shot new-chat prefill", () => {
  it("seeds editable unsent text, preserves history state, and sends only through the normal composer", async () => {
    const { history } = await fixture();
    const textbox = await screen.findByRole("textbox");
    await waitFor(() => expect(textbox).toHaveValue("Help me create an agent."));
    await waitFor(() => expect(history.location.state).not.toHaveProperty("chatPrefill"));
    expect(history.location.state).toMatchObject({
      __TSR_index: 1,
      retained: { value: "keep me" },
      __hashScrollIntoViewOptions: false,
    });
    expect(screen.getByRole("combobox")).toHaveTextContent("Normal default");
    expect(screen.getByRole("textbox")).toBe(textbox);
    expect(sendMessage).not.toHaveBeenCalled();
    fireEvent.change(textbox, { target: { value: "Make it a writing coach instead." } });
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(vi.mocked(sendMessage).mock.calls[0]![0].data).toMatchObject({
      conversationId: null,
      content: "Make it a writing coach instead.",
      modelId: "normal-default",
      attachmentIds: [],
    });
    expect(vi.mocked(sendMessage).mock.calls[0]![0].data).not.toHaveProperty("authoring");
    expect(vi.mocked(sendMessage).mock.calls[0]![0].data).not.toHaveProperty("agentId");
  });

  it("does not reinsert cleared text on refresh, Back/Forward, or remount", async () => {
    const { router, history, tree, view } = await fixture();
    const textbox = await screen.findByRole("textbox");
    await waitFor(() => expect(history.location.state).not.toHaveProperty("chatPrefill"));
    fireEvent.change(textbox, { target: { value: "" } });
    await act(async () => {
      await router.invalidate();
    });
    expect(screen.getByRole("textbox")).toBe(textbox);
    expect(textbox).toHaveValue("");
    act(() => history.back());
    await screen.findByText("Agents destination");
    act(() => history.forward());
    expect(await screen.findByRole("textbox")).toHaveValue("");
    view!.unmount();
    render(tree);
    expect(await screen.findByRole("textbox")).toHaveValue("");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each(["My existing text", ""])(
    "preserves prior typing or clearing (%j) and attached files when a seed arrives late",
    async (value) => {
      const { history, view } = await fixture({ prefill: null });
      const textbox = await screen.findByRole("textbox");
      fireEvent.change(textbox, { target: { value: "Started typing" } });
      fireEvent.change(textbox, { target: { value } });
      fireEvent.change(view!.container.querySelector('input[type="file"]')!, {
        target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
      });
      await screen.findByRole("button", { name: /Remove notes.txt/ });
      act(() =>
        history.replace("/", { ...history.location.state, chatPrefill: "A late shortcut request" }),
      );
      await waitFor(() => expect(history.location.state).not.toHaveProperty("chatPrefill"));
      expect(screen.getByRole("textbox")).toBe(textbox);
      expect(textbox).toHaveValue(value);
      expect(screen.getByRole("button", { name: /Remove notes.txt/ })).toBeVisible();
      expect(sendMessage).not.toHaveBeenCalled();
    },
  );

  it.each([" ", "x".repeat(2_001), { unexpected: "data" }])(
    "ignores and consumes invalid state %#",
    async (prefill) => {
      const { history } = await fixture({ prefill });
      expect(await screen.findByRole("textbox")).toHaveValue("");
      await waitFor(() => expect(history.location.state).not.toHaveProperty("chatPrefill"));
      expect(sendMessage).not.toHaveBeenCalled();
    },
  );

  it("keeps pre-hydration typing and never raises the mobile keyboard while consuming a seed", async () => {
    mobile = true;
    const { history, tree } = await fixture({ mount: false });
    const container = document.createElement("div");
    container.innerHTML = renderToString(tree);
    document.body.append(container);
    const textbox = container.querySelector("textarea")!;
    expect(textbox).toHaveValue("");
    textbox.value = "Typed before hydration";
    const recoverable = vi.fn();
    let root!: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(container, tree, { onRecoverableError: recoverable });
    });
    await waitFor(() => expect(history.location.state).not.toHaveProperty("chatPrefill"));
    expect(screen.getByRole("textbox")).toHaveValue("Typed before hydration");
    expect(screen.getByRole("textbox")).not.toHaveFocus();
    expect(recoverable).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    container.remove();
  });
});
