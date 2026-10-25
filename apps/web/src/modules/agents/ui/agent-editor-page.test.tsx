vi.mock("~/modules/skills/server/functions.ts", () => ({
  listSkills: vi.fn().mockResolvedValue([]),
}));
vi.mock("~/modules/custom-tools/server/functions.ts", () => ({
  listUsableCustomTools: vi.fn().mockResolvedValue([]),
}));
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentEditorPage } from "./agent-editor-page.tsx";
import { ALL_CAPABILITIES } from "~/modules/groups/policy.ts";
import { deleteAgent, updateAgent } from "../server/functions.ts";
import type { AgentDetail } from "../schema.ts";
import { listKnowledgeCollections } from "~/modules/knowledge/server/functions.ts";
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
vi.mock("~/modules/knowledge/server/functions.ts", () => ({
  listKnowledgeCollections: vi.fn(),
  getKnowledgeCollection: vi.fn(),
  createKnowledgeCollection: vi.fn(),
  updateKnowledgeCollection: vi.fn(),
}));
vi.mock("~/modules/sharing/server/functions.ts", () => ({
  getResourceSharing: vi.fn(),
  changeSharing: vi.fn(),
}));
const navigation = vi.hoisted(() => ({
  navigate: vi.fn(),
  blocker: null as null | { shouldBlockFn: () => Promise<boolean>; enableBeforeUnload: boolean },
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
  useNavigate: () => navigation.navigate,
  useBlocker: (options: typeof navigation.blocker) => {
    navigation.blocker = options;
  },
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
  imageModelId: null,
  skills: [],
  customTools: [],
  integrations: [],
  ...overrides,
});

const renderEditor = (
  agent: AgentDetail = detail(),
  collections: Array<Record<string, unknown>> | null = [],
) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["capabilities"], ALL_CAPABILITIES);
  client.setQueryData(["agents", "detail", agent.id], agent);
  client.setQueryData(["chat-models"], []);
  if (collections !== null) client.setQueryData(["knowledge", "collections"], collections);
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <ConfirmProvider>
          <AgentEditorPage agentId={agent.id} />
        </ConfirmProvider>
      </QueryClientProvider>,
    ),
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  navigation.blocker = null;
});

describe("AgentEditorPage", () => {
  it("shows every setting at once and saves what is on screen", async () => {
    renderEditor(detail({ searchEnabled: true, planEnabled: true, starters: ["Review this"] }));
    expect(screen.getByRole("switch", { name: "Working checklist" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Starter 1" })).toHaveValue("Review this");
    fireEvent.change(screen.getByRole("textbox", { name: "Starter 1" }), {
      target: { value: "Review carefully" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(updateAgent).toHaveBeenCalledWith({
        data: {
          agentId: "a1",
          expectedRevision: 1,
          name: "Reviewer",
          description: "Checks contracts",
          instructions: "Be careful.",
          icon: "book",
          modelId: null,
          imageModelId: null,
          searchEnabled: true,
          planEnabled: true,
          starters: ["Review carefully"],
          collectionIds: [],
          skillIds: [],
          customToolIds: [],
          integrationIds: [],
        },
      }),
    );
  });

  it("focuses an invalid starter without discarding what was typed", async () => {
    renderEditor(detail({ starters: ["Valid"] }));
    fireEvent.change(screen.getByRole("textbox", { name: "Starter 1" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Starter 1" })).toHaveFocus());
    expect(screen.getByRole("textbox", { name: "Starter 1" })).toHaveValue("");
    expect(screen.getByText("Check the highlighted fields before saving.")).toBeVisible();
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it("keeps unavailable collections visible and retains their IDs when saving", async () => {
    renderEditor(
      detail({ icon: "robot", collections: [{ id: "missing", name: null, available: false }] }),
    );
    expect(screen.getByText("A collection you can no longer read")).toBeVisible();
    // Save waits for a change; an edit elsewhere must not drop the unreadable ID.
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(updateAgent).toHaveBeenCalledWith({
        data: expect.objectContaining({ collectionIds: ["missing"] }),
      }),
    );
  });

  it("does not report lost collection access while loading", async () => {
    let resolveCollections!: (value: []) => void;
    vi.mocked(listKnowledgeCollections).mockReturnValueOnce(
      new Promise<[]>((resolve) => {
        resolveCollections = resolve;
      }),
    );
    renderEditor(detail({ collections: [{ id: "missing", name: null, available: false }] }), null);
    expect(screen.getByRole("status", { name: "Loading collections" })).toBeVisible();
    expect(screen.queryByText("A collection you can no longer read")).not.toBeInTheDocument();
    resolveCollections([]);
    expect(await screen.findByText("A collection you can no longer read")).toBeVisible();
  });

  it("shows a collection load error rather than claiming access was lost", async () => {
    vi.mocked(listKnowledgeCollections).mockRejectedValueOnce(new Error("Offline"));
    renderEditor(detail({ collections: [{ id: "missing", name: null, available: false }] }), null);
    expect(await screen.findByText("Could not load collections")).toBeVisible();
    expect(screen.queryByText("A collection you can no longer read")).not.toBeInTheDocument();
  });

  it("attaches a collection from a searchable picker rather than a row of switches", async () => {
    const user = userEvent.setup();
    renderEditor(detail(), [
      { id: "c1", name: "Contracts", documentCount: 3, ownerName: null },
      { id: "c2", name: "Policies", documentCount: 1, ownerName: null },
    ]);
    expect(screen.queryByRole("switch", { name: /Contracts/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Add collection" }));
    await user.type(await screen.findByPlaceholderText("Search collections…"), "cont");
    await user.click(await screen.findByRole("option", { name: /Contracts/ }));
    expect(screen.getByRole("button", { name: "Remove Contracts" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(updateAgent).toHaveBeenCalledWith({
        data: expect.objectContaining({ collectionIds: ["c1"] }),
      }),
    );
  });

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

  it("bypasses the dirty leave guard only after deleting an agent", async () => {
    let finishDelete!: () => void;
    vi.mocked(deleteAgent).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishDelete = resolve;
      }) as never,
    );
    renderEditor();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Unsaved name" },
    });
    expect(navigation.blocker?.enableBeforeUnload).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Agent actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete agent" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete agent" }));
    await waitFor(() => expect(deleteAgent).toHaveBeenCalledOnce());
    expect(navigation.navigate).not.toHaveBeenCalled();

    await act(async () => finishDelete());
    await waitFor(() =>
      expect(navigation.navigate).toHaveBeenCalledWith({ to: "/agents", ignoreBlocker: true }),
    );
  });

  it("keeps dirty agent edits guarded when deletion fails", async () => {
    let failDelete!: (error: Error) => void;
    vi.mocked(deleteAgent).mockReturnValueOnce(
      new Promise<void>((_, reject) => {
        failDelete = reject;
      }) as never,
    );
    renderEditor();
    const name = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Unsaved name" } });
    fireEvent.click(screen.getByRole("button", { name: "Agent actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete agent" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete agent" }));
    await waitFor(() => expect(deleteAgent).toHaveBeenCalledOnce());
    await act(async () => failDelete(new Error("Offline")));
    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(name).toHaveValue("Unsaved name");
    expect(navigation.blocker?.enableBeforeUnload).toBe(true);
    let blocked!: Promise<boolean>;
    act(() => {
      blocked = navigation.blocker!.shouldBlockFn();
    });
    expect(await screen.findByText("Discard unsaved changes?")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await blocked).toBe(true);
  });

  it("keeps Start chat and Access beside the menu", () => {
    renderEditor();
    expect(screen.getByRole("link", { name: "Start chat" })).toHaveAttribute("data-agent-id", "a1");
    fireEvent.click(screen.getByRole("button", { name: "Access" }));
    expect(screen.getByRole("dialog", { name: "Access" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Copy link" })).not.toBeInTheDocument();
  });

  it("keeps dirty values and their original revision when another editor updates the query", async () => {
    const { client } = renderEditor();
    const name = screen.getByRole("textbox", { name: "Name" });
    name.focus();
    fireEvent.change(name, { target: { value: "My unsaved name" } });
    act(() =>
      client.setQueryData(
        ["agents", "detail", "a1"],
        detail({ configRevision: 2, name: "Other editor" }),
      ),
    );
    expect(await screen.findByText(/This agent changed elsewhere/)).toBeVisible();
    expect(name).toHaveValue("My unsaved name");
    expect(name).toHaveFocus();
    vi.mocked(updateAgent).mockRejectedValueOnce(new Error("agent changed; reload before saving"));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(updateAgent).toHaveBeenCalledWith({
        data: expect.objectContaining({ expectedRevision: 1, name: "My unsaved name" }),
      }),
    );
    expect(name).toHaveValue("My unsaved name");
    fireEvent.click(screen.getByRole("button", { name: "Reload agent" }));
    await waitFor(() => expect(name).toHaveValue("Other editor"));
    // The reload leaves nothing to save; the next edit saves against revision 2.
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    fireEvent.change(name, { target: { value: "Other editor, amended" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(updateAgent).toHaveBeenLastCalledWith({
        data: expect.objectContaining({ expectedRevision: 2, name: "Other editor, amended" }),
      }),
    );
  });

  it("refuses the editor to a recipient", () => {
    renderEditor(detail({ canEdit: false, ownerName: "Dana" }));
    expect(screen.getByText("Agent editing isn’t available")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Agent actions" })).not.toBeInTheDocument();
  });
});
