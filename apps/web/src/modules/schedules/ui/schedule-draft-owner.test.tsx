import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduleDraftToolActivity } from "~/modules/chat/client/use-message-stream.ts";
import { ScheduleDraftActivityBlock } from "~/modules/chat/ui/schedule-draft-activity-block.tsx";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { DetailPanelProvider, DetailPanelRail } from "~/ui/detail-panel.tsx";
import { AppMotionProvider } from "~/ui/motion";
import { EMPTY_SCHEDULE_DRAFT, type ScheduleDraft } from "../draft-schema.ts";
import {
  discardScheduleDraft,
  getScheduleDraft,
  patchScheduleDraft,
  saveScheduleDraft,
} from "../server/draft-functions.ts";
import { ScheduleDraftOwner, type ScheduleDraftHandle } from "./schedule-draft-owner.tsx";

const environment = vi.hoisted(() => ({ mobile: false }));
vi.mock("../server/draft-functions.ts", () => ({
  getScheduleDraft: vi.fn(),
  patchScheduleDraft: vi.fn(),
  saveScheduleDraft: vi.fn(),
  reloadScheduleDraft: vi.fn(),
  discardScheduleDraft: vi.fn(),
}));
vi.mock("../server/functions.ts", () => ({
  listSchedules: vi.fn(),
  getSchedule: vi.fn(),
  listScheduleRuns: vi.fn(),
  createSchedule: vi.fn(),
  updateSchedule: vi.fn(),
  pauseSchedule: vi.fn(),
  resumeSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
  runScheduleNow: vi.fn(),
  previewSchedule: vi.fn().mockResolvedValue([]),
}));
vi.mock("~/modules/agents/server/functions.ts", () => ({
  listAgents: vi.fn().mockResolvedValue([]),
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
  useBlocker: () => {},
}));
vi.mock("~/ui/use-mobile", () => ({ useIsMobile: () => environment.mobile }));

let server: ScheduleDraft | null;
const fresh = (): ScheduleDraft => ({
  id: "draft-1",
  conversationId: "conversation",
  kind: "schedule",
  settings: {
    ...EMPTY_SCHEDULE_DRAFT,
    name: "Digest",
    scheduleText: "every weekday at 7am",
    cron: "0 7 * * 1-5",
    prompt: "Summarize yesterday.",
  },
  revision: 1,
  targetId: null,
  targetRevision: null,
  savedDraftRevision: null,
  createdAt: "2026-09-10T00:00:00Z",
  updatedAt: "2026-09-10T00:00:00Z",
});
const reference = (callId = "first", draftId = "draft-1"): ScheduleDraftToolActivity => ({
  family: "schedule-draft",
  name: "draft_schedule",
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
  client.setQueryData(["agents", "list"], []);
  const ref = createRef<ScheduleDraftHandle>();
  const gone = vi.fn();
  const tree = (known = present, refs = activities) => (
    <QueryClientProvider client={client}>
      <AppMotionProvider>
        <ConfirmProvider>
          <DetailPanelProvider>
            <main>
              <ScheduleDraftOwner draftIds={known ? ["draft-1"] : []} onGone={gone} ref={ref}>
                {refs.map((activity) => (
                  <ScheduleDraftActivityBlock key={activity.callId} activity={activity} />
                ))}
              </ScheduleDraftOwner>
            </main>
            <DetailPanelRail />
          </DetailPanelProvider>
        </ConfirmProvider>
      </AppMotionProvider>
    </QueryClientProvider>
  );
  const view = render(tree());
  if (open) fireEvent.click(await screen.findByRole("button", { name: /Open schedule draft/ }));
  return {
    ...view,
    ref,
    gone,
    client,
    renderOwner: (known = present, refs = activities) => view.rerender(tree(known, refs)),
  };
};
const remote = (client: QueryClient, changes: Partial<ScheduleDraft["settings"]>) => {
  server = {
    ...server!,
    settings: { ...server!.settings, ...changes },
    revision: server!.revision + 1,
  };
  act(() => client.setQueryData(["drafts", "schedule", "draft-1"], server));
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
  vi.mocked(getScheduleDraft).mockImplementation(async () => server);
  vi.mocked(discardScheduleDraft).mockImplementation(async () => {
    server = null;
  });
  vi.mocked(patchScheduleDraft).mockImplementation(async ({ data }) => {
    if (data.expectedRevision !== server!.revision) return { outcome: "conflict", draft: server! };
    server = {
      ...server!,
      revision: server!.revision + 1,
      settings: { ...server!.settings, ...data.changes },
    };
    return { outcome: "updated", draft: server };
  });
  vi.mocked(saveScheduleDraft).mockImplementation(async ({ data }) => {
    if (data.expectedRevision !== server!.revision) return { outcome: "conflict", draft: server! };
    server = {
      ...server!,
      targetId: server!.targetId ?? "saved-schedule",
      savedDraftRevision: server!.revision,
    };
    return { outcome: "saved", draft: server, scheduleId: server.targetId! };
  });
});

describe("conversation-owned schedule draft", () => {
  it("renders a widget from the persisted reference and opens the panel on click only", async () => {
    const view = await fixture({ open: false });
    const widget = await screen.findByRole("button", { name: "Open schedule draft: Digest" });
    expect(screen.queryByRole("textbox", { name: "Cadence" })).not.toBeInTheDocument();
    fireEvent.click(widget);
    expect(await screen.findByRole("textbox", { name: "Cadence" })).toHaveValue(
      "every weekday at 7am",
    );
    expect(getScheduleDraft).toHaveBeenCalledWith({ data: { draftId: "draft-1" } });
    expect(view.gone).not.toHaveBeenCalled();
  });

  it("keeps a branch-copied reference inert", async () => {
    const historical: ScheduleDraftToolActivity = {
      ...reference("copied"),
      result: {
        outcome: "drafted",
        draftId: "draft-1",
        draftConversationId: "original-conversation",
        revision: 1,
      },
    };
    await fixture({ open: false, present: false, activities: [historical] });
    expect(screen.getByText("From another chat")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Open schedule draft/ })).not.toBeInTheDocument();
    expect(getScheduleDraft).not.toHaveBeenCalled();
  });

  it("offers an inline choice for same-field edits and blocks flush until resolved", async () => {
    const { client, ref } = await fixture();
    const prompt = await screen.findByRole("textbox", { name: "Prompt" });
    fireEvent.change(prompt, { target: { value: "Mine" } });
    remote(client, { prompt: "Theirs" });
    expect(await screen.findByRole("region", { name: "Prompt conflict" })).toBeVisible();
    expect(prompt).toHaveValue("Mine");
    await act(async () => {
      expect(await ref.current!.flush()).toBe(false);
    });
    expect(patchScheduleDraft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep my prompt" }));
    await waitFor(() => expect(server!.settings.prompt).toBe("Mine"));
    expect(screen.queryByRole("region", { name: "Prompt conflict" })).not.toBeInTheDocument();
  });

  it("creates the schedule only on the explicit button and then links its page", async () => {
    await fixture();
    fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), {
      target: { value: "Morning digest" },
    });
    await waitFor(() => expect(patchScheduleDraft).toHaveBeenCalled());
    expect(saveScheduleDraft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Create schedule" }));
    await waitFor(() =>
      expect(saveScheduleDraft).toHaveBeenCalledWith({
        data: { draftId: "draft-1", expectedRevision: 2 },
      }),
    );
    expect(await screen.findByText("Schedule saved")).toBeVisible();
    expect(screen.getByRole("link", { name: "Open schedule" })).toHaveAttribute(
      "href",
      "/schedules/saved-schedule",
    );
    expect(screen.queryByRole("button", { name: "Discard draft" })).not.toBeInTheDocument();
  });

  it("discards on confirmation and reports the draft gone", async () => {
    const { gone } = await fixture();
    fireEvent.click(await screen.findByRole("button", { name: "Discard draft" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard draft", hidden: false }));
    await waitFor(() => expect(discardScheduleDraft).toHaveBeenCalledWith({ data: { draftId: "draft-1" } }));
    await waitFor(() => expect(gone).toHaveBeenCalledWith("draft-1"));
  });
});
