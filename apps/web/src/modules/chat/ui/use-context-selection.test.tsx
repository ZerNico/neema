import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  AgentPicker,
  CollectionPicker,
  AgentChip,
  ContextMenuItems,
  MAX_SELECTED_COLLECTIONS,
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

const NAMES: Record<string, string> = { "collection-1": "Contracts", "collection-2": "Policies" };

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
        <AgentChip
          agent={context.selection.agent}
          agentLocked={context.agentLocked}
          onAgentChange={context.onAgentChange}
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
          side="top"
        />
      )}
      <CollectionPicker
        selection={context.selection}
        agentCollectionIds={context.agentCollectionIds}
        maxCollections={context.maxCollections}
        onCollectionsChange={context.onCollectionsChange}
        open={picker === "collections"}
        onOpenChange={(open) => setPicker(open ? "collections" : null)}
        anchor={anchor}
        side="top"
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
    collections: agentCollections.map((id) => ({ id, name: NAMES[id] ?? id, available: true })),
  });
  client.setQueryData(
    ["knowledge", "collections"],
    [collection("collection-1", "Contracts"), collection("collection-2", "Policies")],
  );
  return render(
    <QueryClientProvider client={client}>
      <AppMotionProvider>
        <Harness initial={initial} />
      </AppMotionProvider>
    </QueryClientProvider>,
  );
};

describe("composer context selection", () => {
  it("shows an installed agent as nothing in the composer and sends only the person's picks", () => {
    setup({
      mode: "installed",
      agent: { id: AGENT.id, name: "Reviewer", collectionIds: ["collection-1"] },
    });
    // Collections are per message, so an empty list is sent even when untouched.
    expect(latest.sendFields).toEqual({ collectionIds: [] });
    const chips = screen.getByLabelText("Chat context");
    // The chat header names the agent; its collection rides along unseen.
    expect(within(chips).queryByText("Reviewer")).toBeNull();
    expect(within(chips).queryByText("Contracts")).toBeNull();
    expect(latest.selection.collectionIds).toEqual([]);
    act(() => latest.onAgentChange(null));
    expect(latest.selection.agent?.id).toBe(AGENT.id);
  });

  it("keeps a pick the agent also brings out of the selection while that agent is chosen", () => {
    setup({ mode: "draft", agent: null });
    act(() => latest.onCollectionsChange(["collection-1", "collection-2"]));
    act(() => latest.onAgentChange(AGENT.id));
    expect(latest.sendFields).toEqual({ agentId: AGENT.id, collectionIds: ["collection-2"] });
    // The agent's collection counts toward the per-message limit.
    expect(latest.maxCollections).toBe(MAX_SELECTED_COLLECTIONS - 1);
    act(() => latest.onAgentChange(null));
    expect(latest.selection.collectionIds).toEqual(["collection-1", "collection-2"]);
  });

  it("keeps a hidden pick through other changes while the agent is chosen", () => {
    setup({ mode: "draft", agent: null });
    act(() => latest.onCollectionsChange(["collection-1"]));
    act(() => latest.onAgentChange(AGENT.id));
    // Every caller sees only the visible picks and passes those back.
    act(() => latest.onCollectionsChange([...latest.selection.collectionIds, "collection-2"]));
    act(() => latest.onAgentChange(null));
    expect(latest.selection.collectionIds).toEqual(["collection-2", "collection-1"]);
  });

  it("shows a chosen agent as one chip and removes it with everything it brought", () => {
    setup({ mode: "draft", agent: { id: AGENT.id, name: "Reviewer" } });
    expect(latest.agentCollectionIds).toEqual(new Set(["collection-1"]));
    const chips = screen.getByLabelText("Chat context");
    expect(within(chips).getAllByRole("button")).toHaveLength(1);
    expect(within(chips).queryByText("Contracts")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove Reviewer" }));
    expect(latest.selection.agent).toBeNull();
    expect(latest.agentCollectionIds.size).toBe(0);
    expect(latest.sendFields).toEqual({ collectionIds: [] });
  });

  it("sends picked collections with this message and clears them on settle, keeping the agent", async () => {
    setup({
      mode: "installed",
      agent: { id: AGENT.id, name: "Reviewer", collectionIds: ["collection-1"] },
    });
    await openPicker(/Knowledge/, "Search collections…");
    // The agent's own collection is not offered: it comes with the agent.
    expect(screen.queryByRole("option", { name: /Contracts/ })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /Policies/ }));
    // A tick is a draft: nothing leaves the popup until Add.
    expect(latest.sendFields).toEqual({ collectionIds: [] });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(latest.sendFields).toEqual({ collectionIds: ["collection-2"] });
    // A picked collection is a tag in the composer's text, not a chip here.
    expect(within(screen.getByLabelText("Chat context")).queryByText("Policies")).toBeNull();
    act(() => latest.settle());
    // Like attached files: gone from the composer once the message left.
    expect(latest.sendFields).toEqual({ collectionIds: [] });
    expect(latest.selection.agent).toMatchObject({ id: AGENT.id });
  });

  it("drops a standalone collection unticked in the popup", async () => {
    setup({ mode: "draft", agent: null });
    await openPicker(/Knowledge/, "Search collections…");
    fireEvent.click(screen.getByRole("option", { name: /Contracts/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(latest.sendFields).toEqual({ collectionIds: ["collection-1"] });
    await openPicker(/Knowledge/, "Search collections…");
    fireEvent.click(screen.getByRole("option", { name: /Contracts/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
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
    act(() => latest.onAgentChange(null));
    expect(latest.selection.agent).toMatchObject({ id: AGENT.id });
    expect(latest.sendFields).toEqual({ collectionIds: [] });
    // The knowledge picker stays: an agent chat can still attach a collection
    // to this message, beside the agent's own.
    await openPicker(/Knowledge/, "Search collections…");
    fireEvent.click(screen.getByRole("option", { name: /Policies/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(latest.sendFields).toEqual({ collectionIds: ["collection-2"] });
  });
});
