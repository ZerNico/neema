import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getAgentSelection } from "~/modules/agents/server/functions.ts";
import { describe, expect, it, vi } from "vitest";
import { NewChatView } from "./chat-view.tsx";
import { ALL_CAPABILITIES } from "~/modules/groups/policy.ts";
import { composerText } from "./composer-test-utils.ts";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
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
vi.mock("../client/time-zone.ts", () => ({ browserTimeZone: () => "Europe/Berlin" }));
vi.mock("~/modules/tools/server/functions.ts", () => ({ getWebSearchAvailability: vi.fn() }));
vi.mock("~/modules/agents/server/functions.ts", () => ({
  listAgents: vi.fn(),
  getAgent: vi.fn(),
  getAgentSelection: vi.fn(),
}));
vi.mock("~/modules/knowledge/server/functions.ts", () => ({
  listKnowledgeCollections: vi.fn(),
  getKnowledgeCollection: vi.fn(),
}));
vi.mock("~/modules/attachments/server/functions.ts", () => ({
  getDocumentParsingAvailability: vi.fn(),
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...rest }: Record<string, unknown> & { children?: unknown }) => (
    <a href={String(to)} {...(rest as object)}>
      {children as never}
    </a>
  ),
  useNavigate: () => vi.fn(),
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: "/" }, matches: [] }),
}));
vi.stubGlobal(
  "matchMedia",
  vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
);

const AGENT = {
  id: "agent-1",
  name: "Reviewer",
  description: "",
  icon: "book",
  audience: "private" as const,
  configRevision: 1,
  canEdit: true,
  ownerName: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
  instructions: "",
  modelId: null,
  searchEnabled: false,
  planEnabled: false,
  starters: ["Summarize this contract", "List the key risks"],
  model: null,
  collections: [],
};

const renderNewChat = (
  initialAgentId: string | null,
  preferred = false,
  seed = true,
  searchAvailable = false,
) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  client.setQueryData(["capabilities"], ALL_CAPABILITIES);
  client.setQueryData(
    ["chat-models"],
    [
      {
        id: "m1",
        providerId: "p",
        providerName: "P",
        modelKey: "m1",
        displayName: "Model One",
        type: "chat",
        enabled: true,
        contextLength: 128_000,
        capabilities: { reasoning: false, tools: true, vision: false, files: false },
      },
    ].flatMap((model) => [model, { ...model, id: "m2", modelKey: "m2", displayName: "Model Two" }]),
  );
  client.setQueryData(["agents", "list"], [AGENT]);
  if (seed)
    client.setQueryData(
      ["agents", "selection", AGENT.id],
      preferred
        ? { ...AGENT, modelId: "m2", model: { id: "m2", name: "Model Two", available: true } }
        : AGENT,
    );
  client.setQueryData(["knowledge", "collections"], []);
  client.setQueryData(["tools", "web-search", "availability"], { enabled: searchAvailable });
  return render(
    <QueryClientProvider client={client}>
      <NewChatView user={{ name: "Nico" }} initialAgentId={initialAgentId} />
    </QueryClientProvider>,
  );
};

describe("new chat image model", () => {
  const imageModel = (id: string, displayName: string) => ({
    id,
    displayName,
    description: null,
    imageCapabilities: null,
    providerName: "P",
    isDefault: false,
  });
  const renderWithImages = (agentImageModelId: string | null) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
    });
    client.setQueryData(["capabilities"], ALL_CAPABILITIES);
    client.setQueryData(["chat-models"], []);
    client.setQueryData(
      ["image-models"],
      [imageModel("img-1", "First Image"), imageModel("img-2", "Agent Image")],
    );
    client.setQueryData(["agents", "list"], [AGENT]);
    client.setQueryData(["agents", "selection", AGENT.id], {
      ...AGENT,
      imageModelId: agentImageModelId,
    });
    client.setQueryData(["knowledge", "collections"], []);
    client.setQueryData(["tools", "web-search", "availability"], { enabled: false });
    return render(
      <QueryClientProvider client={client}>
        <NewChatView user={{ name: "Nico" }} initialAgentId={AGENT.id} />
      </QueryClientProvider>,
    );
  };

  it("shows the agent's image model, which the first answer draws with", async () => {
    renderWithImages("img-2");
    await userEvent.click(screen.getByRole("button", { name: "Add files or tools" }));
    expect(
      await screen.findByRole("menuitem", { name: /^Image model\s?Agent Image$/ }),
    ).toBeInTheDocument();
  });

  it("shows the admin's first when the agent prefers none", async () => {
    renderWithImages(null);
    await userEvent.click(screen.getByRole("button", { name: "Add files or tools" }));
    expect(
      await screen.findByRole("menuitem", { name: /^Image model\s?First Image$/ }),
    ).toBeInTheDocument();
  });
});

describe("new chat composer", () => {
  it("puts the caret in the composer on arrival", async () => {
    renderNewChat(null);
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveFocus());
  });
});

describe("conversation starters", () => {
  it("shows the selected agent's starters and seeds the draft without sending", async () => {
    renderNewChat(AGENT.id);
    const list = screen.getByRole("list", { name: "Conversation starters" });
    expect(list).toHaveTextContent("Summarize this contract");
    fireEvent.click(screen.getByRole("button", { name: "List the key risks" }));
    // The composer field has no accessible name of its own; it is the only one.
    const draft = screen.getByRole("textbox");
    expect(composerText(draft)).toBe("List the key risks");
    // The editor takes focus on the next frame.
    await waitFor(() => expect(document.activeElement).toBe(draft));
  });

  it("applies the available agent model instead of the ordinary default", () => {
    renderNewChat(AGENT.id, true);
    expect(screen.getByRole("combobox")).toHaveTextContent("Model Two");
  });

  it("does not let a delayed agent preference replace an explicit model choice", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof getAgentSelection>>) => void;
    vi.mocked(getAgentSelection).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    renderNewChat(AGENT.id, false, false);
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: /Model Two/ }));
    expect(screen.getByRole("combobox")).toHaveTextContent("Model Two");
    await act(async () => {
      resolve({ ...AGENT, modelId: "m1", model: { id: "m1", name: "Model One", available: true } });
    });
    expect(screen.getByRole("combobox")).toHaveTextContent("Model Two");
  });

  it("seeds the agent search preference once without overriding a later explicit toggle", () => {
    renderNewChat(AGENT.id, false, true, true);
    const search = screen.getByRole("button", { name: "Search the web" });
    expect(search).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(search);
    expect(search).toHaveAttribute("aria-pressed", "true");
  });

  it("does not let a delayed search preference override an explicit draft choice", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof getAgentSelection>>) => void;
    vi.mocked(getAgentSelection).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    renderNewChat(AGENT.id, false, false, true);
    const search = screen.getByRole("button", { name: "Search the web" });
    expect(search).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(search);
    expect(search).toHaveAttribute("aria-pressed", "false");
    await act(async () => {
      resolve({ ...AGENT, searchEnabled: true });
    });
    expect(search).toHaveAttribute("aria-pressed", "false");
  });

  it("shows nothing without an agent", () => {
    renderNewChat(null);
    expect(screen.queryByRole("list", { name: "Conversation starters" })).not.toBeInTheDocument();
  });
});
