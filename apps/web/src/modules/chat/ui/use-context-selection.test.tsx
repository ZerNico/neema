import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  AgentBar,
  AgentPicker,
  CollectionPicker,
  ContextChips,
  ContextMenuItems,
  type ContextPickerKind,
} from "./context-picker.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { useContextSelection } from "./use-context-selection.ts";
import { AppMotionProvider } from "~/ui/motion.tsx";

vi.mock("~/modules/agents/server/functions.ts", () => ({
  listAgents: vi.fn(),
  getAgent: vi.fn(),
  getAgentSelection: vi.fn(),
}));
vi.mock("~/modules/knowledge/server/functions.ts", () => ({
  listKnowledgeCollections: vi.fn(),
  getKnowledgeCollection: vi.fn(),
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
  configRevision: 2,
  canEdit: true,
  ownerName: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const collection = (id: string, name: string) => ({
  id,
  name,
  description: "",
  audience: "private" as const,
  canEdit: true,
  ownerName: null,
  documentCount: 2,
  readyCount: 2,
  failedCount: 0,
  pendingCount: 0,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

let latest: ReturnType<typeof useContextSelection>;

function Harness({ initial }: { initial: Parameters<typeof useContextSelection>[0] }) {
  const context = useContextSelection(initial);
  // Captured after commit, not during render: reading the hook's current value
  // is the point of the harness, and assigning it while rendering is a side effect.
  useEffect(() => {
    latest = context;
  });
  // Mirrors ChatInput: a menu row queues its popup, which opens once the
  // menu has finished closing, anchored to the menu button.
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [pending, setPending] = useState<ContextPickerKind | null>(null);
  const [picker, setPicker] = useState<ContextPickerKind | null>(null);
  return (
    <>
      <div aria-label="Chat context">
        {context.agentLocked && context.selection.agent ? (
          <AgentBar agent={context.selection.agent} />
        ) : null}
        <ContextChips
          selection={context.selection}
          agentCollectionIds={context.agentCollectionIds}
          agentLocked={context.agentLocked}
          onAgentChange={context.onAgentChange}
          onCollectionsChange={context.onCollectionsChange}
          disabled={false}
        />
      </div>
      <DropdownMenu
        onOpenChangeComplete={(open) => {
          if (open || pending === null) return;
          setPicker(pending);
          setPending(null);
        }}
      >
        <DropdownMenuTrigger ref={setAnchor}>Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <ContextMenuItems
            selection={context.selection}
            agentLocked={context.agentLocked}
            onPick={setPending}
            disabled={false}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      {context.agentLocked ? null : (
        <AgentPicker
          selection={context.selection}
          onAgentChange={context.onAgentChange}
          open={picker === "agent"}
          onOpenChange={(open) => setPicker(open ? "agent" : null)}
          anchor={anchor}
        />
      )}
      <CollectionPicker
        selection={context.selection}
        agentCollectionIds={context.agentCollectionIds}
        onCollectionsChange={context.onCollectionsChange}
        open={picker === "collections"}
        onOpenChange={(open) => setPicker(open ? "collections" : null)}
        anchor={anchor}
      />
    </>
  );
}

// Base UI opens the menu off a native click, not a synthetic one; the popup
// then mounts once the menu has closed.
const openPicker = async (row: RegExp, placeholder: string) => {
  screen.getByRole("button", { name: "Menu" }).click();
  fireEvent.click(await screen.findByRole("menuitem", { name: row }));
  await screen.findByPlaceholderText(placeholder);
};

const setup = (
  initial: Parameters<typeof useContextSelection>[0],
  agentCollections: string[] = ["collection-1"],
) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  client.setQueryData(["agents", "list"], [AGENT]);
  client.setQueryData(["agents", "selection", AGENT.id], {
    ...AGENT,
    instructions: "",
    modelId: null,
    searchEnabled: false,
    planEnabled: false,
    starters: [],
    model: null,
    collections: agentCollections.map((id) => ({ id, name: `Collection ${id}`, available: true })),
  });
  client.setQueryData(
    ["knowledge", "collections"],
    [collection("collection-1", "Contracts"), collection("collection-2", "Policies")],
  );
  const tree = (contextInput: Parameters<typeof useContextSelection>[0]) => (
    <QueryClientProvider client={client}>
      <AppMotionProvider>
        <Harness initial={contextInput} />
      </AppMotionProvider>
    </QueryClientProvider>
  );
  const view = render(tree(initial));
  return {
    ...view,
    updateInitial: (next: Parameters<typeof useContextSelection>[0]) => view.rerender(tree(next)),
  };
};

describe("composer context selection", () => {
  it("keeps the association fixed and sends no standalone agent selection", () => {
    setup({
      mode: "installed",
      agent: { id: AGENT.id, name: "Reviewer", collectionIds: ["collection-1"] },
    });
    // Collections are per message, so an empty list is sent even when untouched.
    expect(latest.sendFields).toEqual({ collectionIds: [] });
    const chips = screen.getByLabelText("Chat context");
    expect(within(chips).getByText("Reviewer")).toBeInTheDocument();
    // The agent's own collection is shown as attached, not sent separately.
    expect(within(chips).getByText("Contracts")).toBeInTheDocument();
    expect(within(chips).getByText("From agent")).toBeInTheDocument();
    expect(latest.selection.collectionIds).toEqual(["collection-1"]);
  });

  it("refreshes live identity and dependencies without dropping overlapping standalone selections", () => {
    const view = setup({
      mode: "installed",
      agent: { id: AGENT.id, name: "Before", icon: "code", collectionIds: ["collection-1"] },
    });
    act(() => latest.onCollectionsChange(["collection-1", "collection-2"]));
    expect(latest.sendFields.collectionIds).toEqual(["collection-2"]);
    view.updateInitial({
      mode: "installed",
      agent: { id: AGENT.id, name: "After", icon: "book", collectionIds: ["collection-2"] },
    });
    expect(latest.selection.agent).toEqual({ id: AGENT.id, name: "After", icon: "book" });
    expect(screen.getByRole("status", { name: "Agent: After" })).toBeInTheDocument();
    expect(latest.selection.collectionIds).toEqual(["collection-2"]);
    expect(latest.sendFields.collectionIds).toEqual(["collection-2"]);
    act(() => latest.onCollectionsChange(["collection-2"]));
    expect(latest.sendFields.collectionIds).toEqual(["collection-2"]);
    view.updateInitial({
      mode: "installed",
      agent: { id: AGENT.id, name: "After", icon: "book", collectionIds: [] },
    });
    expect(latest.selection.collectionIds).toEqual(["collection-2"]);
    act(() => latest.onAgentChange(null));
    expect(latest.selection.agent?.id).toBe(AGENT.id);
  });

  it("preserves a standalone choice when a draft agent adds the same dependency", () => {
    setup({ mode: "draft", agent: null });
    act(() => latest.onCollectionsChange(["collection-1"]));
    act(() => latest.onAgentChange(AGENT.id));
    expect(latest.sendFields).toEqual({ agentId: AGENT.id, collectionIds: ["collection-1"] });
    act(() => latest.onAgentChange(null));
    expect(latest.selection.collectionIds).toEqual(["collection-1"]);
  });

  it("removes a draft agent and its attached collections before chat creation", () => {
    setup({ mode: "draft", agent: { id: AGENT.id, name: "Reviewer" } });
    expect(screen.queryByRole("button", { name: "Remove Contracts" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove Reviewer" }));
    expect(latest.selection.agent).toBeNull();
    expect(latest.selection.collectionIds).toEqual([]);
    expect(latest.sendFields).toEqual({ collectionIds: [] });
  });

  it("sends picked collections with this message and clears them on settle, keeping the agent", async () => {
    setup({
      mode: "installed",
      agent: { id: AGENT.id, name: "Reviewer", collectionIds: ["collection-1"] },
    });
    await openPicker(/Knowledge/, "Search collections…");
    // The agent's own collection is shown selected but cannot be toggled off.
    expect(screen.getByRole("option", { name: /Contracts/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("option", { name: /Contracts/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    fireEvent.click(screen.getByRole("option", { name: /Policies/ }));
    // A tick is a draft: nothing leaves the popup until Add.
    expect(latest.sendFields).toEqual({ collectionIds: [] });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(latest.sendFields).toEqual({ collectionIds: ["collection-2"] });
    expect(within(screen.getByLabelText("Chat context")).getByText("Policies")).toBeInTheDocument();
    act(() => latest.settle());
    // Like attached files: gone from the composer once the message left.
    expect(latest.sendFields).toEqual({ collectionIds: [] });
    expect(latest.selection.agent).toMatchObject({ id: AGENT.id });
    expect(latest.selection.collectionIds).toEqual(["collection-1"]);
  });

  it("preserves popup ticks through a live dependency refresh without adopting removed dependencies", async () => {
    const view = setup({
      mode: "installed",
      agent: { id: AGENT.id, name: "Reviewer", collectionIds: ["collection-1"] },
    });
    await openPicker(/Knowledge/, "Search collections…");
    fireEvent.click(screen.getByRole("option", { name: /Policies/ }));
    view.updateInitial({
      mode: "installed",
      agent: { id: AGENT.id, name: "Renamed", collectionIds: ["collection-2"] },
    });
    expect(screen.getByRole("option", { name: /Contracts/ })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    // The effective union now matches, but this tick is still a standalone
    // request and must be committed even though it also became a dependency.
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(latest.sendFields.collectionIds).toEqual(["collection-2"]);
    view.updateInitial({
      mode: "installed",
      agent: { id: AGENT.id, name: "Renamed", collectionIds: [] },
    });
    expect(latest.selection.collectionIds).toEqual(["collection-2"]);
  });

  it("drops a standalone collection from its chip", async () => {
    setup({ mode: "draft", agent: null });
    await openPicker(/Knowledge/, "Search collections…");
    fireEvent.click(screen.getByRole("option", { name: /Contracts/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(latest.sendFields).toEqual({ collectionIds: ["collection-1"] });
    fireEvent.click(screen.getByRole("button", { name: "Remove Contracts" }));
    expect(latest.sendFields).toEqual({ collectionIds: [] });
  });

  it("searches agents by name and picks one from the popup", async () => {
    setup({ mode: "draft", agent: null });
    await openPicker(/^Agent/, "Search agents…");
    fireEvent.change(screen.getByPlaceholderText("Search agents…"), {
      target: { value: "nothing here" },
    });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No agents match")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Search agents…"), {
      target: { value: "review" },
    });
    fireEvent.click(screen.getByRole("option", { name: /Reviewer/ }));
    expect(latest.sendFields).toEqual({ agentId: AGENT.id, collectionIds: [] });
    expect(within(screen.getByLabelText("Chat context")).getByText("Reviewer")).toBeInTheDocument();
  });

  it("explains an empty agent list inside the popup", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
    });
    client.setQueryData(["agents", "list"], []);
    client.setQueryData(["knowledge", "collections"], []);
    render(
      <QueryClientProvider client={client}>
        <AppMotionProvider>
          <Harness initial={{ mode: "draft", agent: null }} />
        </AppMotionProvider>
      </QueryClientProvider>,
    );
    await openPicker(/^Agent/, "Search agents…");
    // Base UI appends an invisible word joiner to live-region text.
    expect(screen.getByRole("status")).toHaveTextContent(/No agents yet/);
  });

  it("locks the association of an existing conversation but still takes extra knowledge per message", async () => {
    setup(
      {
        mode: "installed",
        agent: { id: AGENT.id, name: "Reviewer", collectionIds: ["collection-1"] },
      },
      ["collection-2"],
    );
    screen.getByRole("button", { name: "Menu" }).click();
    expect(await screen.findByRole("menuitem", { name: /Knowledge/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /^Agent/ })).not.toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Remove Reviewer" })).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Agent: Reviewer" })).toBeInTheDocument();
    // The agent's collections still ride along; only standalone ones are per message.
    expect(latest.selection.collectionIds).toEqual(["collection-1"]);
    act(() => latest.onAgentChange(null));
    expect(latest.selection.agent).toMatchObject({ id: AGENT.id });
    expect(latest.sendFields).toEqual({ collectionIds: [] });
    // The knowledge picker stays: an agent chat can still attach a collection
    // to this message, beside the agent's own.
    await openPicker(/Knowledge/, "Search collections…");
    fireEvent.click(screen.getByRole("option", { name: /Policies/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(latest.sendFields).toEqual({ collectionIds: ["collection-2"] });
    expect(latest.selection.collectionIds).toEqual(["collection-1", "collection-2"]);
  });

  it("marks an agent that no longer resolves instead of dropping it", () => {
    setup({ mode: "installed", agent: { id: "gone", name: null, collectionIds: [] } });
    const chips = screen.getByLabelText("Chat context");
    expect(within(chips).getByText("Agent unavailable")).toBeInTheDocument();
    expect(within(chips).getByText("No longer available to you")).toBeInTheDocument();
  });
});
