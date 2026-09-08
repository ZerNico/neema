import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentEditorPage } from "./agent-editor-page.tsx";
import { deleteAgent } from "../server/functions.ts";
import type { AgentDetail } from "../schema.ts";
import { ConfirmProvider } from "~/ui/confirm.tsx";

vi.mock("../server/functions.ts", () => ({
  listAgents: vi.fn(),
  getAgent: vi.fn(),
  getAgentSelection: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
}));
vi.mock("~/modules/chat/server/functions.ts", () => ({
  listChatModels: vi.fn(),
  listConversations: vi.fn(),
  getConversationWithMessages: vi.fn(),
}));
vi.mock("~/modules/knowledge/server/functions.ts", () => ({
  listKnowledgeCollections: vi.fn(),
  getKnowledgeCollection: vi.fn(),
  createKnowledgeCollection: vi.fn(),
  updateKnowledgeCollection: vi.fn(),
}));
vi.mock("~/modules/sharing/server/functions.ts", () => ({
  getResourceSharing: vi.fn(),
  shareResourceWithEmail: vi.fn(),
  shareResourceWithGroup: vi.fn(),
  revokeResourceUser: vi.fn(),
  revokeResourceGroup: vi.fn(),
  publishResource: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    search,
    children,
    ...rest
  }: Record<string, unknown> & { children?: unknown }) => (
    <a
      href={String(to)}
      data-agent-id={
        (params as { agentId?: string } | undefined)?.agentId ??
        (search as { agent?: string } | undefined)?.agent
      }
      {...(rest as object)}
    >
      {children as never}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));
vi.stubGlobal(
  "matchMedia",
  vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
);

const detail = (overrides: Partial<AgentDetail> = {}): AgentDetail => ({
  id: "a1",
  name: "Reviewer",
  description: "Checks contracts",
  icon: "book",
  audience: "private",
  configRevision: 1,
  canEdit: true,
  ownerName: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
  instructions: "Be careful.",
  modelId: null,
  searchEnabled: false,
  planEnabled: false,
  starters: [],
  model: null,
  collections: [],
  ...overrides,
});

const renderEditor = (agent: AgentDetail = detail()) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["agents", "detail", agent.id], agent);
  client.setQueryData(["chat-models"], []);
  client.setQueryData(["knowledge", "collections"], []);
  return render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <AgentEditorPage agentId={agent.id} />
      </ConfirmProvider>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AgentEditorPage", () => {
  it("deletes from the header menu after confirmation, not from the form footer", async () => {
    renderEditor();
    // The destructive action lives in the header menu, like a collection's.
    expect(screen.queryByRole("button", { name: /Delete agent/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Agent actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete agent/ }));
    expect(await screen.findByText(/keep the instructions they ran with/i)).toBeInTheDocument();
    expect(vi.mocked(deleteAgent)).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete agent" }));
    await waitFor(() =>
      expect(vi.mocked(deleteAgent)).toHaveBeenCalledWith({ data: { agentId: "a1" } }),
    );
  });

  it("keeps Start chat and Share beside the menu", () => {
    renderEditor();
    expect(screen.getByRole("link", { name: "Start chat" })).toHaveAttribute("data-agent-id", "a1");
    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
  });

  it("refuses the editor to a recipient", () => {
    renderEditor(detail({ canEdit: false, ownerName: "Dana" }));
    expect(screen.getByText("This agent isn't yours to edit")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Agent actions" })).not.toBeInTheDocument();
  });
});
