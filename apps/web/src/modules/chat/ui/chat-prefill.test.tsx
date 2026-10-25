import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "~/routes/_app.index.tsx";
import { ALL_CAPABILITIES } from "~/modules/groups/policy.ts";
import { sendMessage } from "../server/functions.ts";
import { scheduleAuthoringRequest } from "~/modules/schedules/authoring.ts";
import { uploadAttachment } from "~/modules/attachments/server/functions.ts";
import { HeaderSlot, HeaderSlotProvider } from "~/ui/header-slot.tsx";
import { AppMotionProvider } from "~/ui/motion.tsx";
import { composerText, setComposerText } from "./composer-test-utils.ts";

vi.mock("../server/functions.ts", () => ({
  getConversationWithMessages: vi.fn(),
  listConversations: vi.fn(),
  listChatModels: vi.fn(),
  branchConversation: vi.fn(),
  sendMessage: vi.fn(),
  answerQuestion: vi.fn(),
  resumeMessage: vi.fn(),
  retryMessage: vi.fn(),
  editMessage: vi.fn(),
  stopGeneration: vi.fn(),
}));
vi.mock("~/modules/tools/server/functions.ts", () => ({
  getComposerAvailability: vi.fn(),
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
  client.setQueryData(["capabilities"], ALL_CAPABILITIES);
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
  client.setQueryData(
    ["schedules"],
    [
      {
        id: "s1",
        name: "Morning digest",
        scheduleText: "Every weekday at 07:00",
        cron: "0 7 * * 1-5",
        timezone: "UTC",
        paused: false,
        nextFireAt: null,
        lastFiredAt: null,
      },
    ],
  );
  client.setQueryData(["knowledge", "collections"], []);
  client.setQueryData(["skills"], []);
  client.setQueryData(["tools", "availability"], {
    search: { configured: false, enabled: false },
    research: { configured: false, enabled: false },
    documentParsing: { configured: false, enabled: false },
  });
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
      <AppMotionProvider>
        <HeaderSlotProvider>
          <header>
            <HeaderSlot />
          </header>
          <RouterProvider router={router} />
        </HeaderSlotProvider>
      </AppMotionProvider>
    </QueryClientProvider>
  );
  const view = mount ? render(tree) : null;
  return { router, history, tree, view };
}

describe("one-shot new-chat prefill", () => {
  it("seeds editable unsent text, preserves history state, and sends only through the normal composer", async () => {
    const { history } = await fixture();
    const textbox = await screen.findByRole("textbox");
    await waitFor(() => expect(composerText(textbox)).toBe("Help me create an agent."));
    await waitFor(() => expect(history.location.state).not.toHaveProperty("chatPrefill"));
    expect(history.location.state).toMatchObject({
      __TSR_index: 1,
      retained: { value: "keep me" },
      __hashScrollIntoViewOptions: false,
    });
    expect(screen.getByRole("combobox")).toHaveTextContent("Normal default");
    expect(screen.getByRole("textbox")).toBe(textbox);
    expect(sendMessage).not.toHaveBeenCalled();
    setComposerText(textbox, "Make it a writing coach instead.");
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(vi.mocked(sendMessage).mock.calls[0]![0].data).toMatchObject({
      conversation: { kind: "new", id: expect.any(String), mode: "chat" },
      content: "Make it a writing coach instead.",
      modelId: "normal-default",
      attachmentIds: [],
    });
    expect(vi.mocked(sendMessage).mock.calls[0]![0].data).not.toHaveProperty("authoring");
    expect(vi.mocked(sendMessage).mock.calls[0]![0].data).not.toHaveProperty("agentId");
  });

  it("shows what an edit request is about as a chip and sends the link it came with", async () => {
    const request = scheduleAuthoringRequest("s1");
    await fixture({ prefill: request });
    const textbox = await screen.findByRole("textbox");
    await waitFor(() =>
      expect(composerText(textbox)).toBe(
        "Help me change this schedule. Ask what I’d like to change, then prepare a draft for me to review before saving.",
      ),
    );
    // The chip arrives after mount, so it grows in rather than appearing at once.
    await waitFor(() => expect(screen.getByText("Morning digest")).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(vi.mocked(sendMessage).mock.calls[0]![0].data).toMatchObject({ content: request });
  });

  it("does not reinsert cleared text on refresh, Back/Forward, or remount", async () => {
    const { router, history, tree, view } = await fixture();
    const textbox = await screen.findByRole("textbox");
    await waitFor(() => expect(history.location.state).not.toHaveProperty("chatPrefill"));
    setComposerText(textbox, "");
    await act(async () => {
      await router.invalidate();
    });
    expect(screen.getByRole("textbox")).toBe(textbox);
    expect(composerText(textbox)).toBe("");
    act(() => history.back());
    await screen.findByText("Agents destination");
    act(() => history.forward());
    expect(composerText(await screen.findByRole("textbox"))).toBe("");
    view!.unmount();
    render(tree);
    expect(composerText(await screen.findByRole("textbox"))).toBe("");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each(["My existing text", ""])(
    "preserves prior typing or clearing (%j) and attached files when a seed arrives late",
    async (value) => {
      const { history, view } = await fixture({ prefill: null });
      const textbox = await screen.findByRole("textbox");
      setComposerText(textbox, "Started typing");
      setComposerText(textbox, value);
      fireEvent.change(view!.container.querySelector('input[type="file"]')!, {
        target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
      });
      await screen.findByRole("button", { name: /Remove notes.txt/ });
      act(() =>
        history.replace("/", { ...history.location.state, chatPrefill: "A late shortcut request" }),
      );
      await waitFor(() => expect(history.location.state).not.toHaveProperty("chatPrefill"));
      expect(screen.getByRole("textbox")).toBe(textbox);
      expect(composerText(textbox)).toBe(value);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /Remove notes.txt/ })).toBeVisible(),
      );
      expect(sendMessage).not.toHaveBeenCalled();
    },
  );

  it.each([" ", "x".repeat(2_001), { unexpected: "data" }])(
    "ignores and consumes invalid state %#",
    async (prefill) => {
      const { history } = await fixture({ prefill });
      expect(composerText(await screen.findByRole("textbox"))).toBe("");
      await waitFor(() => expect(history.location.state).not.toHaveProperty("chatPrefill"));
      expect(sendMessage).not.toHaveBeenCalled();
    },
  );

  it("never raises the mobile keyboard while consuming a seed", async () => {
    mobile = true;
    const { history } = await fixture();
    await waitFor(() => expect(history.location.state).not.toHaveProperty("chatPrefill"));
    expect(composerText(screen.getByRole("textbox"))).toBe("Help me create an agent.");
    // The editor focuses a frame after asking; let one pass so this proves something.
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    expect(screen.getByRole("textbox")).not.toHaveFocus();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("temporary new chat", () => {
  it("keeps the draft when switched on, records it in the address and sends it", async () => {
    const { history } = await fixture({ prefill: null });
    const textbox = await screen.findByRole("textbox");
    setComposerText(textbox, "Something private");
    const toggle = screen.getByRole("button", { name: "Temporary chat" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    await waitFor(() => expect(history.location.search).toBe("?temporary=1"));
    expect(screen.getByRole("button", { name: "Temporary chat" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Presence only: both enter from opacity 0, and jsdom runs no animation.
    expect(screen.getByRole("heading", { name: "Temporary chat" })).toBeInTheDocument();
    expect(screen.getByText(/won’t appear in your history/)).toBeInTheDocument();
    expect(composerText(screen.getByRole("textbox"))).toBe("Something private");
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(vi.mocked(sendMessage).mock.calls[0]![0].data).toMatchObject({
      conversation: { kind: "new", mode: "chat", temporary: true },
    });
  });

  it("sends an ordinary chat without the flag", async () => {
    await fixture();
    fireEvent.click(await screen.findByRole("button", { name: /^Send$/ }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(vi.mocked(sendMessage).mock.calls[0]![0].data.conversation).not.toHaveProperty(
      "temporary",
    );
  });
});
