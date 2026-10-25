import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentsPage } from "./agents-page.tsx";
import { ALL_CAPABILITIES } from "~/modules/groups/policy.ts";
import { deleteAgent } from "../server/functions.ts";
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
  sendMessage: vi.fn(),
  listChatModels: vi.fn(),
  listConversations: vi.fn(),
  getConversationWithMessages: vi.fn(),
}));
vi.mock("~/modules/sharing/server/functions.ts", () => ({
  getResourceSharing: vi.fn(),
  changeSharing: vi.fn(),
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

const agent = (overrides: {
  id: string;
  name: string;
  canEdit?: boolean;
  ownerName?: string | null;
  audience?: "private" | "instance";
  description?: string;
}) => ({
  id: overrides.id,
  name: overrides.name,
  description: overrides.description ?? "",
  icon: "book",
  audience: overrides.audience ?? ("private" as const),
  configRevision: 1,
  canEdit: overrides.canEdit ?? true,
  ownerName: overrides.ownerName ?? null,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const renderPage = (agents: ReturnType<typeof agent>[]) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["capabilities"], ALL_CAPABILITIES);
  client.setQueryData(["agents", "list"], agents);
  return render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <AgentsPage />
      </ConfirmProvider>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AgentsPage", () => {
  it("offers Start chat to everyone and owner actions only in the owner's menu", () => {
    renderPage([
      agent({ id: "a1", name: "Reviewer", description: "Checks contracts" }),
      agent({ id: "a2", name: "Analyst", canEdit: false, ownerName: "Dana" }),
    ]);
    expect(screen.getByRole("link", { name: "Start chat with Reviewer" })).toHaveAttribute(
      "data-agent-id",
      "a1",
    );
    expect(screen.getByRole("link", { name: "Start chat with Analyst" })).toBeInTheDocument();
    // A recipient gets no menu at all: no Edit, no Access, no Delete.
    expect(screen.queryByRole("button", { name: "Actions for Analyst" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Actions for Reviewer" }));
    expect(screen.getByRole("menuitem", { name: /^Edit$/ })).toHaveAttribute("data-agent-id", "a1");
    expect(screen.getByRole("menuitem", { name: /Access/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Delete/ })).toBeInTheDocument();
    expect(screen.getByText(/Shared by Dana/)).toBeInTheDocument();
    expect(screen.getByText("Shared with you")).toBeInTheDocument();
  });

  it("falls back to the agent's age instead of a bare 'No description'", async () => {
    renderPage([agent({ id: "a1", name: "Reviewer" })]);
    expect(screen.queryByText("No description")).not.toBeInTheDocument();
    expect(await screen.findByText(/^Updated /)).toBeInTheDocument();
  });

  it("confirms before deleting and does nothing when the confirmation is cancelled", async () => {
    renderPage([agent({ id: "a1", name: "Reviewer" })]);
    fireEvent.click(screen.getByRole("button", { name: "Actions for Reviewer" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete/ }));
    expect(await screen.findByText(/keep the instructions they ran with/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByText(/keep the instructions they ran with/i)).not.toBeInTheDocument(),
    );
    expect(vi.mocked(deleteAgent)).not.toHaveBeenCalled();
  });

  it("deletes through the existing server function once confirmed", async () => {
    renderPage([agent({ id: "a1", name: "Reviewer" })]);
    fireEvent.click(screen.getByRole("button", { name: "Actions for Reviewer" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete agent" }));
    await waitFor(() =>
      expect(vi.mocked(deleteAgent)).toHaveBeenCalledWith({ data: { agentId: "a1" } }),
    );
  });

  it("marks instance-published agents and offers creation when empty", () => {
    const { unmount } = renderPage([agent({ id: "a1", name: "Public", audience: "instance" })]);
    expect(screen.getByText("Everyone")).toBeInTheDocument();
    expect(screen.queryByText("Shared with you")).not.toBeInTheDocument();
    unmount();
    renderPage([]);
    expect(screen.getByText("No agents yet")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /New agent/ }).length).toBeGreaterThan(0);
  });
});
