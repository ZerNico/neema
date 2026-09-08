vi.mock("~/modules/skills/server/functions.ts", () => ({
  listSkills: vi.fn().mockResolvedValue([]),
}));
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NewChatView } from "./chat-view.tsx";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
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
  useRouterState: () => "/",
}));
vi.stubGlobal(
  "matchMedia",
  vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
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

describe("new chat composer on a phone", () => {
  it("leaves focus alone, because focusing would raise the keyboard", () => {
    renderNewChat(null);
    expect(screen.getByRole("textbox")).not.toHaveFocus();
  });
});
