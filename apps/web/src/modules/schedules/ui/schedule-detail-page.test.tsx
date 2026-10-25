import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import {
  deleteSchedule,
  listScheduleRuns,
  runScheduleNow,
  updateSchedule,
} from "../server/functions.ts";
import { ScheduleDetailPage } from "./schedule-detail-page.tsx";

vi.mock("../server/functions.ts", () => ({
  listSchedules: vi.fn().mockResolvedValue([]),
  getSchedule: vi.fn(),
  listScheduleRuns: vi.fn().mockResolvedValue({ runs: [], nextCursor: null }),
  createSchedule: vi.fn(),
  updateSchedule: vi.fn(),
  pauseSchedule: vi.fn(),
  resumeSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
  runScheduleNow: vi.fn(),
  previewSchedule: vi.fn().mockResolvedValue([]),
}));
vi.mock("~/modules/chat/server/functions.ts", () => ({
  listChatModels: vi.fn().mockResolvedValue([]),
  listConversations: vi.fn().mockResolvedValue({ conversations: [], nextCursor: null }),
}));
vi.mock("~/modules/knowledge/server/functions.ts", () => ({
  listKnowledgeCollections: vi.fn().mockResolvedValue([]),
  createKnowledgeCollection: vi.fn(),
}));
vi.mock("~/modules/skills/server/functions.ts", () => ({
  listSkills: vi.fn().mockResolvedValue([]),
}));
const navigation = vi.hoisted(() => ({
  navigate: vi.fn(),
  blocker: null as null | { shouldBlockFn: () => Promise<boolean>; enableBeforeUnload: boolean },
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
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

const schedule = {
  id: "s1",
  name: "Digest",
  prompt: "Summarize the news",
  scheduleText: "Every day at 07:00",
  cron: "0 7 * * *",
  timezone: "UTC",
  endAt: null,
  modelId: null,
  agentId: null,
  imageModelId: null,
  searchEnabled: false,
  researchEnabled: false,
  collectionIds: [],
  skillIds: [],
  chatMode: "new" as const,
  chatId: null,
  integrationGrants: [],
  notify: "always" as const,
  paused: false,
};

const renderPage = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["schedule", "s1"], schedule);
  client.setQueryData(["chat-models"], []);
  render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <ScheduleDetailPage scheduleId="s1" />
      </ConfirmProvider>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  navigation.blocker = null;
  vi.mocked(runScheduleNow).mockResolvedValue(undefined as never);
});

describe("ScheduleDetailPage runs", () => {
  it("shows policy-skipped runs as non-link rows", async () => {
    vi.mocked(listScheduleRuns).mockResolvedValue({
      runs: [
        {
          id: "r1",
          conversationId: null,
          conversationTitle: null,
          firedAt: new Date().toISOString(),
          status: "skipped",
          error: "schedule access is not permitted",
        },
      ],
      nextCursor: null,
    });
    renderPage();
    expect(await screen.findByText("Skipped")).toBeInTheDocument();
    expect(screen.getByText("schedule access is not permitted")).toBeInTheDocument();
    expect(screen.getByText("Skipped").closest("li")?.querySelector("a")).toBeNull();
  });
});

describe("ScheduleDetailPage delete", () => {
  it("navigates past dirty edits only after deletion succeeds", async () => {
    let finishDelete!: () => void;
    vi.mocked(deleteSchedule).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishDelete = resolve;
      }) as never,
    );
    renderPage();
    fireEvent.change(await screen.findByLabelText("Prompt"), {
      target: { value: "Unsaved prompt" },
    });
    expect(navigation.blocker?.enableBeforeUnload).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Schedule actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete schedule" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete schedule" }));
    await waitFor(() =>
      expect(deleteSchedule).toHaveBeenCalledWith({ data: { scheduleId: "s1" } }),
    );
    expect(navigation.navigate).not.toHaveBeenCalled();

    await act(async () => finishDelete());
    await waitFor(() =>
      expect(navigation.navigate).toHaveBeenCalledWith({ to: "/schedules", ignoreBlocker: true }),
    );
  });

  it("preserves the dirty leave guard if deletion fails", async () => {
    let failDelete!: (error: Error) => void;
    vi.mocked(deleteSchedule).mockReturnValueOnce(
      new Promise<void>((_, reject) => {
        failDelete = reject;
      }) as never,
    );
    renderPage();
    const prompt = await screen.findByLabelText("Prompt");
    fireEvent.change(prompt, { target: { value: "Unsaved prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete schedule" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete schedule" }));
    await waitFor(() => expect(deleteSchedule).toHaveBeenCalledOnce());
    await act(async () => failDelete(new Error("Offline")));

    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(prompt).toHaveValue("Unsaved prompt");
    expect(navigation.blocker?.enableBeforeUnload).toBe(true);
    let blocked!: Promise<boolean>;
    act(() => {
      blocked = navigation.blocker!.shouldBlockFn();
    });
    expect(await screen.findByText("Discard unsaved changes?")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await blocked).toBe(true);
  });
});

describe("ScheduleDetailPage run now", () => {
  it("runs the saved schedule straight away when nothing is edited", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Run now" }));
    await waitFor(() => expect(runScheduleNow).toHaveBeenCalledOnce());
    expect(updateSchedule).not.toHaveBeenCalled();
  });

  it("saves pending edits first, so the run uses what is on screen", async () => {
    vi.mocked(updateSchedule).mockResolvedValue(undefined as never);
    renderPage();
    fireEvent.change(await screen.findByLabelText("Prompt"), {
      target: { value: "Summarize the tech news" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(runScheduleNow).toHaveBeenCalledOnce());
    expect(vi.mocked(updateSchedule).mock.calls[0]![0].data.settings).toMatchObject({
      prompt: "Summarize the tech news",
    });
    expect(vi.mocked(updateSchedule).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runScheduleNow).mock.invocationCallOrder[0]!,
    );
  });

  it("does not run when saving the edits fails", async () => {
    vi.mocked(updateSchedule).mockRejectedValue(
      new Error("a schedule can run at most once an hour"),
    );
    renderPage();
    fireEvent.change(await screen.findByLabelText("Prompt"), {
      target: { value: "Summarize the tech news" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(updateSchedule).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole("button", { name: "Run now" })).toBeEnabled());
    expect(runScheduleNow).not.toHaveBeenCalled();
  });
});
