import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef, useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_AGENT_DRAFT, type AgentDraft } from "../draft-schema.ts";
import {
  discardAgentDraft,
  getAgentDraft,
  patchAgentDraft,
  reloadAgentDraft,
  saveAgentDraft,
} from "../server/draft-functions.ts";
import { AgentDraftOwner, type AgentDraftHandle } from "./agent-draft-owner.tsx";
import {
  DetailPanelProvider,
  DetailPanelRail,
  useDetailPanel,
  type DetailPanelApi,
} from "~/ui/detail-panel.tsx";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { AppMotionProvider } from "~/ui/motion";
import { AgentDraftActivityBlock } from "~/modules/chat/ui/agent-draft-activity-block.tsx";
import type { AgentDraftToolActivity } from "~/modules/chat/client/use-message-stream.ts";

const environment = vi.hoisted(() => ({ mobile: false }));
const blocker = vi.hoisted(() => ({
  current: null as null | {
    shouldBlockFn: () => Promise<boolean>;
    enableBeforeUnload: () => boolean;
  },
}));
vi.mock("../server/draft-functions.ts", () => ({
  getAgentDraft: vi.fn(),
  patchAgentDraft: vi.fn(),
  saveAgentDraft: vi.fn(),
  reloadAgentDraft: vi.fn(),
  discardAgentDraft: vi.fn(),
}));
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
  listChatModels: vi.fn().mockResolvedValue([]),
  listConversations: vi.fn(),
  getConversationWithMessages: vi.fn(),
}));
vi.mock("~/modules/knowledge/server/functions.ts", () => ({
  listKnowledgeCollections: vi.fn().mockResolvedValue([]),
  getKnowledgeCollection: vi.fn(),
  createKnowledgeCollection: vi.fn(),
  updateKnowledgeCollection: vi.fn(),
}));
vi.mock("~/modules/skills/server/functions.ts", () => ({
  listSkills: vi.fn().mockResolvedValue([]),
}));
vi.mock("@tanstack/react-router", () => ({
  // Params are interpolated so a test can tell which agent a link points at.
  Link: ({
    children,
    to,
    params,
  }: {
    children: React.ReactNode;
    to: string;
    params?: Record<string, string>;
  }) => (
    <a
      href={Object.entries(params ?? {}).reduce(
        (path, [key, value]) => path.replace(`$${key}`, value),
        to,
      )}
    >
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
  useRouterState: () => "/chat/conversation",
  useBlocker: (options: typeof blocker.current) => {
    blocker.current = options;
  },
}));
vi.mock("~/ui/use-mobile", () => ({ useIsMobile: () => environment.mobile }));
let server: AgentDraft | null;
let extra: AgentDraft | null = null;
let panel: DetailPanelApi;
function Probe() {
  const api = useDetailPanel();
  useEffect(() => {
    panel = api;
  }, [api]);
  return null;
}
const fresh = (): AgentDraft => ({
  id: "draft-1",
  conversationId: "conversation",
  kind: "agent",
  settings: { ...EMPTY_AGENT_DRAFT, name: "Writer", instructions: "Original instructions" },
  revision: 1,
  targetId: null,
  targetRevision: null,
  savedDraftRevision: null,
  createdAt: "2026-09-10T00:00:00Z",
  updatedAt: "2026-09-10T00:00:00Z",
});
const reference = (callId = "first", draftId = "draft-1"): AgentDraftToolActivity => ({
  family: "agent-draft",
  name: "draft_agent",
  callId,
  turnIndex: 0,
  callIndex: 0,
  status: "complete",
  result: { outcome: "drafted", draftId, draftConversationId: "conversation", revision: 1 },
});
const fixture = async ({ open = true, present = true, activities = [reference()] } = {}) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(["chat-models"], []);
  client.setQueryData(["knowledge", "collections"], []);
  client.setQueryData(["skills", "list"], []);
  const ref = createRef<AgentDraftHandle>();
  const gone = vi.fn();
  const tree = (known = present, refs = activities) => (
    <QueryClientProvider client={client}>
      <AppMotionProvider>
        <ConfirmProvider>
          <DetailPanelProvider>
            <main>
              <AgentDraftOwner
                draftIds={known ? (extra ? ["draft-1", "draft-2"] : ["draft-1"]) : []}
                onGone={gone}
                ref={ref}
              >
                {refs.map((activity) => (
                  <AgentDraftActivityBlock key={activity.callId} activity={activity} />
                ))}
              </AgentDraftOwner>
              <Probe />
            </main>
            <DetailPanelRail />
          </DetailPanelProvider>
        </ConfirmProvider>
      </AppMotionProvider>
    </QueryClientProvider>
  );
  const view = render(tree());
  if (open) fireEvent.click(await screen.findByRole("button", { name: /Open agent draft/ }));
  return {
    ...view,
    ref,
    gone,
    client,
    renderOwner: (known = present, refs = activities) => view.rerender(tree(known, refs)),
  };
};
const remote = (client: QueryClient, changes: Partial<AgentDraft["settings"]>) => {
  server = {
    ...server!,
    settings: { ...server!.settings, ...changes },
    revision: server!.revision + 1,
  };
  act(() => client.setQueryData(["drafts", "agent", "draft-1"], server));
};
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
beforeEach(() => {
  vi.clearAllMocks();
  server = fresh();
  environment.mobile = false;
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("max-width") ? environment.mobile : true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  extra = null;
  vi.mocked(getAgentDraft).mockImplementation(async ({ data }) =>
    data.draftId === "draft-2" ? extra : server,
  );
  vi.mocked(discardAgentDraft).mockImplementation(async ({ data }) => {
    if (data.draftId === "draft-2") extra = null;
    else server = null;
  });
  vi.mocked(patchAgentDraft).mockImplementation(async ({ data }) => {
    const second = data.draftId === "draft-2";
    const row = second ? extra! : server!;
    if (data.expectedRevision !== row.revision) return { outcome: "conflict", draft: row };
    const next = {
      ...row,
      revision: row.revision + 1,
      settings: { ...row.settings, ...data.changes },
    };
    if (second) extra = next;
    else server = next;
    return { outcome: "updated", draft: next };
  });
  vi.mocked(saveAgentDraft).mockImplementation(async ({ data }) => {
    if (data.expectedRevision !== server!.revision) return { outcome: "conflict", draft: server! };
    server = {
      ...server!,
      targetId: server!.targetId ?? "saved-agent",
      targetRevision: (server!.targetRevision ?? 0) + 1,
      savedDraftRevision: server!.revision,
    };
    return {
      outcome: "saved",
      draft: server,
      agentId: server.targetId!,
      configRevision: server.targetRevision!,
    };
  });
});

describe("conversation-owned agent draft", () => {
  it("fetches a late draft only when its existence is known, without opening the panel", async () => {
    const view = await fixture({ open: false, present: false, activities: [] });
    expect(getAgentDraft).not.toHaveBeenCalled();
    view.renderOwner(true, [reference()]);
    const widget = await screen.findByRole("button", { name: "Open agent draft: Writer" });
    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
    fireEvent.click(widget);
    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue("Writer");
  });

  it("shares one panel across references and retains edits when every widget unmounts", async () => {
    const view = await fixture();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Local work" },
    });
    view.renderOwner(true, []);
    remote(view.client, { description: "Changed offscreen" });
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Local work");
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    view.renderOwner(true, [reference(), reference("second")]);
    const widgets = await screen.findAllByRole("button", { name: "Open agent draft: Local work" });
    fireEvent.click(widgets[1]!);
    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue("Local work");
    expect(screen.getByRole("textbox", { name: "Description (optional)" })).toHaveValue(
      "Changed offscreen",
    );
    expect(widgets.every((widget) => widget.getAttribute("aria-expanded") === "true")).toBe(true);
  });

  it("never connects a copied branch reference to the branch’s later draft", async () => {
    const historical = reference("copied", "original-conversation");
    const view = await fixture({ open: false, present: false, activities: [historical] });
    expect(getAgentDraft).not.toHaveBeenCalled();
    expect(screen.getByText("From another chat")).toBeVisible();
    view.renderOwner(true, [historical, reference("branch-own")]);
    const widget = await screen.findByRole("button", { name: "Open agent draft: Writer" });
    expect(screen.getAllByRole("button", { name: /Open agent draft/ })).toHaveLength(1);
    expect(screen.getByText("From another chat")).toBeVisible();
    fireEvent.click(widget);
    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue("Writer");
    expect(getAgentDraft).toHaveBeenCalledWith({ data: { draftId: "draft-1" } });
    expect(getAgentDraft).not.toHaveBeenCalledWith({
      data: { draftId: "original-conversation" },
    });
  });

  it("hydrates the actual shared fields, keeps clean remote fields current, and patches only local changes", async () => {
    const { client, ref } = await fixture();
    const name = await screen.findByRole("textbox", { name: "Name" });
    expect(name).toHaveValue("Writer");
    name.focus();
    fireEvent.change(name, { target: { value: "My writer" } });
    remote(client, { description: "From the assistant" });
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Description (optional)" })).toHaveValue(
        "From the assistant",
      ),
    );
    expect(name).toHaveFocus();
    expect(name).toHaveValue("My writer");
    await act(async () => {
      expect(await ref.current!.flush()).toBe(true);
    });
    expect(patchAgentDraft).toHaveBeenCalledWith({
      data: { draftId: "draft-1", expectedRevision: 2, changes: { name: "My writer" } },
    });
    expect(saveAgentDraft).not.toHaveBeenCalled();
    expect(screen.getAllByText("Draft").length).toBeGreaterThan(0);
  });

  it("persists partial draft values without treating autosave as an agent save", async () => {
    await fixture();
    const name = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Add starter" }));
    await waitFor(() => expect(patchAgentDraft).toHaveBeenCalled());
    expect(server!.settings).toMatchObject({ name: "", starters: [""] });
    expect(saveAgentDraft).not.toHaveBeenCalled();
    expect(screen.queryByText("Agent saved")).not.toBeInTheDocument();
  });

  it("offers an inline choice for same-field edits rather than replacing or resubmitting local text", async () => {
    const { client, ref } = await fixture();
    const name = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Mine" } });
    remote(client, { name: "Theirs" });
    expect(await screen.findByRole("region", { name: "Name conflict" })).toBeVisible();
    expect(name).toHaveValue("Mine");
    await act(async () => {
      expect(await ref.current!.flush()).toBe(false);
    });
    expect(patchAgentDraft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep my name" }));
    await waitFor(() => expect(server!.settings.name).toBe("Mine"));
    expect(screen.queryByRole("region", { name: "Name conflict" })).not.toBeInTheDocument();
  });

  it("preserves later keystrokes through an in-flight acknowledgement and ignores older responses", async () => {
    const { client, ref } = await fixture();
    const name = await screen.findByRole("textbox", { name: "Name" });
    const blocked = gate();
    const old = server!;
    vi.mocked(patchAgentDraft).mockImplementationOnce(async ({ data }) => {
      server = { ...server!, revision: 2, settings: { ...server!.settings, ...data.changes } };
      const acknowledgement = server;
      await blocked.promise;
      return { outcome: "updated", draft: acknowledgement };
    });
    fireEvent.change(name, { target: { value: "First edit" } });
    let flushing!: Promise<boolean>;
    act(() => {
      flushing = ref.current!.flush();
    });
    await waitFor(() => expect(patchAgentDraft).toHaveBeenCalledTimes(1));
    fireEvent.change(name, { target: { value: "Later keystrokes" } });
    act(() => client.setQueryData(["drafts", "agent", "draft-1"], server));
    expect(name).toHaveValue("Later keystrokes");
    await act(async () => {
      blocked.release();
      expect(await flushing).toBe(true);
    });
    expect(server!.settings.name).toBe("Later keystrokes");
    expect(screen.queryByRole("region", { name: "Name conflict" })).not.toBeInTheDocument();
    act(() => client.setQueryData(["drafts", "agent", "draft-1"], old));
    expect(name).toHaveValue("Later keystrokes");
    expect(patchAgentDraft).toHaveBeenCalledTimes(2);
  });

  it("reports the agent as saved after Create even when the row comes back with reordered keys", async () => {
    // Postgres returns jsonb with its own key order; equality must be per field.
    const reordered = (settings: AgentDraft["settings"]): AgentDraft["settings"] =>
      Object.fromEntries(Object.entries(settings).reverse()) as AgentDraft["settings"];
    vi.mocked(saveAgentDraft).mockImplementation(async ({ data }) => {
      if (data.expectedRevision !== server!.revision)
        return { outcome: "conflict", draft: server! };
      server = {
        ...server!,
        settings: reordered(server!.settings),
        targetId: "saved-agent",
        targetRevision: 1,
        savedDraftRevision: server!.revision,
      };
      return { outcome: "saved", draft: server, agentId: "saved-agent", configRevision: 1 };
    });
    await fixture();
    await screen.findByRole("textbox", { name: "Name" });
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
    expect(await screen.findByText("Agent saved")).toBeVisible();
    expect(screen.queryByText("Draft changes pending")).not.toBeInTheDocument();
    expect(patchAgentDraft).not.toHaveBeenCalled();
  });

  it("requires another Save click when flushing discovers unseen assistant changes", async () => {
    await fixture();
    await screen.findByRole("textbox", { name: "Name" });
    server = {
      ...server!,
      revision: 2,
      settings: { ...server!.settings, instructions: "New assistant instructions" },
    };
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
    expect(
      await screen.findByText("The draft changed. Review it, then choose Save again."),
    ).toBeVisible();
    expect(saveAgentDraft).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue(
      "New assistant instructions",
    );
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() =>
      expect(saveAgentDraft).toHaveBeenCalledWith({
        data: { draftId: "draft-1", expectedRevision: 2 },
      }),
    );
    expect(await screen.findByText("Agent saved")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeVisible();
  });

  it("blocks dependent actions and navigation after failed draft persistence without losing input", async () => {
    const { ref } = await fixture();
    const name = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Keep this local text" } });
    vi.mocked(patchAgentDraft).mockRejectedValue(new Error("Offline"));
    await act(async () => {
      expect(await ref.current!.flush()).toBe(false);
    });
    expect(name).toHaveValue("Keep this local text");
    expect(screen.getByRole("alert")).toHaveTextContent("Offline");
    expect(blocker.current!.enableBeforeUnload()).toBe(true);
    await act(async () => {
      expect(await blocker.current!.shouldBlockFn()).toBe(true);
    });
    expect(saveAgentDraft).not.toHaveBeenCalled();
  });

  it("retains form state when closed, replaced by Sources, or moved between desktop and mobile", async () => {
    const view = await fixture();
    const name = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Persistent input" } });
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    remote(view.client, { description: "Does not reopen" });
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Open agent draft/ }));
    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue("Persistent input");
    act(() => panel.open({ id: "sources", title: "Sources", body: <p>Source content</p> }));
    remote(view.client, { instructions: "Still does not steal Sources" });
    expect(screen.getByText("Source content")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Open agent draft/ }));
    environment.mobile = true;
    view.renderOwner();
    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue("Persistent input");
  });

  it.each([false, true])("waits for an explicit widget click on mobile=%s", async (mobile) => {
    environment.mobile = mobile;
    await fixture({ open: false });
    const widget = await screen.findByRole("button", { name: /Open agent draft/ });
    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Draft" })).not.toBeInTheDocument();
    fireEvent.click(widget);
    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue("Writer");
  });

  it("edits two drafts of one chat independently and flushes both before a send", async () => {
    extra = {
      ...fresh(),
      id: "draft-2",
      settings: { ...EMPTY_AGENT_DRAFT, name: "Second" },
    };
    const { ref } = await fixture({
      open: false,
      activities: [reference("first", "draft-1"), reference("second", "draft-2")],
    });
    fireEvent.click(await screen.findByRole("button", { name: "Open agent draft: Writer" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), {
      target: { value: "Writer edited" },
    });
    // Opening the other draft swaps the panel; the first keeps its edit.
    fireEvent.click(screen.getByRole("button", { name: "Open agent draft: Second" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), {
      target: { value: "Second edited" },
    });
    await act(async () => {
      expect(await ref.current!.flush()).toBe(true);
    });
    expect(server!.settings.name).toBe("Writer edited");
    expect(extra!.settings.name).toBe("Second edited");
    fireEvent.click(screen.getByRole("button", { name: "Open agent draft: Writer edited" }));
    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue("Writer edited");
  });

  it("offers no discard once the draft is saved, there being nothing to throw away", async () => {
    server = { ...fresh(), targetId: "saved-agent", targetRevision: 1, savedDraftRevision: 1 };
    await fixture();

    expect(await screen.findByRole("textbox", { name: "Name" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard draft" })).not.toBeInTheDocument();
  });

  it("offers the editor behind a button rather than a sentence of link text", async () => {
    server = { ...fresh(), targetId: "saved-agent", targetRevision: 1, savedDraftRevision: 1 };
    await fixture();

    const editor = await screen.findByRole("link", { name: "Open in editor" });
    expect(editor).toHaveAttribute("href", "/agents/saved-agent");
  });

  it("discards one draft on confirmation and leaves the other alone", async () => {
    extra = { ...fresh(), id: "draft-2", settings: { ...EMPTY_AGENT_DRAFT, name: "Second" } };
    await fixture({ activities: [reference("first", "draft-1"), reference("second", "draft-2")] });
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard draft", hidden: false }));
    await waitFor(() => expect(discardAgentDraft).toHaveBeenCalled());
    expect(vi.mocked(discardAgentDraft).mock.calls[0]![0]).toEqual({
      data: { draftId: "draft-1" },
    });
    expect(extra).not.toBeNull();
  });

  it("keeps unavailable dependency identities visible and removable in the actual shared fields", async () => {
    server = {
      ...server!,
      settings: {
        ...server!.settings,
        collectionIds: ["revoked"],
        skillIds: ["removed"],
        modelId: "deleted-model",
      },
    };
    const { ref } = await fixture();
    expect(await screen.findByText("A collection you can no longer read")).toBeVisible();
    expect(await screen.findByText("Unavailable skill")).toBeVisible();
    const model = screen.getByRole("combobox", { name: "Preferred model" });
    expect(model).toHaveTextContent("Unavailable model");
    fireEvent.click(screen.getByRole("button", { name: "Remove unavailable collection" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove unavailable skill" }));
    fireEvent.click(model);
    fireEvent.click(await screen.findByRole("option", { name: "No preference" }));
    await act(async () => {
      expect(await ref.current!.flush()).toBe(true);
    });
    expect(server!.settings).toMatchObject({ modelId: null, collectionIds: [], skillIds: [] });
  });

  it("leaves a missing draft unavailable and blocks flush rather than fabricating initial state", async () => {
    server = null;
    const { ref } = await fixture({ open: false });
    expect(await screen.findByText("Could not load draft")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Open agent draft/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry loading draft" })).toBeVisible();
    await act(async () => {
      expect(await ref.current!.flush()).toBe(false);
    });
    expect(patchAgentDraft).not.toHaveBeenCalled();
    expect(saveAgentDraft).not.toHaveBeenCalled();
  });

  it("explicitly reloads a changed agent while preserving the draft until that choice", async () => {
    server = { ...server!, targetId: "existing", targetRevision: 1 };
    await fixture();
    const name = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Working copy" } });
    vi.mocked(saveAgentDraft).mockImplementationOnce(async () => ({
      outcome: "agent_changed",
      draft: server!,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/This agent changed elsewhere/)).toBeVisible();
    expect(name).toHaveValue("Working copy");
    vi.mocked(reloadAgentDraft).mockImplementationOnce(async () => {
      server = {
        ...server!,
        revision: server!.revision + 1,
        targetRevision: 2,
        settings: { ...EMPTY_AGENT_DRAFT, name: "Current saved agent" },
      };
      return { outcome: "reloaded", draft: server };
    });
    fireEvent.click(screen.getByRole("button", { name: "Reload agent" }));
    // The working copy is only given up once the consequence has been named.
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("replaced by the agent’s current settings");
    expect(name).toHaveValue("Working copy");

    fireEvent.click(within(dialog).getByRole("button", { name: "Reload agent" }));
    await waitFor(() => expect(name).toHaveValue("Current saved agent"));
    expect(reloadAgentDraft).toHaveBeenCalledTimes(1);
  });

  it("reloads a saved draft without asking, there being no edits to lose", async () => {
    server = { ...fresh(), targetId: "saved-agent", targetRevision: 1, savedDraftRevision: 1 };
    await fixture();
    vi.mocked(reloadAgentDraft).mockImplementationOnce(async () => ({
      outcome: "reloaded",
      draft: server!,
    }));

    fireEvent.click(await screen.findByRole("button", { name: "Reload agent" }));

    await waitFor(() => expect(reloadAgentDraft).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
