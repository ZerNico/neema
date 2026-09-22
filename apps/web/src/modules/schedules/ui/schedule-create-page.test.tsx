import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSchedule } from "../server/functions.ts";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { ScheduleCreatePage } from "./schedule-create-page.tsx";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("../server/functions.ts", () => ({
  listSchedules: vi.fn().mockResolvedValue([]),
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
vi.mock("~/modules/chat/server/functions.ts", () => ({
  listChatModels: vi.fn().mockResolvedValue([]),
}));
vi.mock("~/modules/knowledge/server/functions.ts", () => ({
  listKnowledgeCollections: vi.fn().mockResolvedValue([]),
  createKnowledgeCollection: vi.fn(),
}));
vi.mock("~/modules/skills/server/functions.ts", () => ({
  listSkills: vi.fn().mockResolvedValue([]),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  useNavigate: () => navigate,
  useBlocker: vi.fn(),
}));
vi.stubGlobal(
  "matchMedia",
  vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
);

beforeEach(() => {
  vi.clearAllMocks();
});

const renderPage = () => {
  vi.mocked(createSchedule).mockResolvedValue({ id: "s-new" } as never);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <ScheduleCreatePage />
      </ConfirmProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
};

const pick = async (user: ReturnType<typeof userEvent.setup>, select: string, option: string) => {
  await user.click(screen.getByRole("combobox", { name: select }));
  await user.click(await screen.findByRole("option", { name: option }));
};

const submitted = async () => {
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Digest" } });
  fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Summarize the news" } });
  fireEvent.click(screen.getByRole("button", { name: "Create schedule" }));
  await waitFor(() => expect(vi.mocked(createSchedule)).toHaveBeenCalledOnce());
  return vi.mocked(createSchedule).mock.calls[0]![0].data;
};

describe("ScheduleCreatePage", () => {
  it("moves from Weekdays to Weekly on one day instead of snapping back", async () => {
    const user = renderPage();
    await pick(user, "Frequency", "Weekdays");
    await pick(user, "Frequency", "Weekly");
    expect(screen.getByRole("combobox", { name: "Frequency" })).toHaveTextContent("Weekly");
    await pick(user, "Day of the week", "Friday");
    expect(await submitted()).toMatchObject({
      cron: "0 9 * * 5",
      scheduleText: "Every Friday at 09:00",
    });
  });

  it("builds a stepped cadence in the Custom card and keeps the card open", async () => {
    const user = renderPage();
    await pick(user, "Frequency", "Custom");
    await pick(user, "Repeats", "Hourly");
    await pick(user, "Every", "2 hours");
    expect(screen.getByRole("combobox", { name: "Frequency" })).toHaveTextContent("Custom");
    await pick(user, "Every", "1 hour");
    // A plain hourly cron fits the preset row, but Custom was chosen and stays.
    expect(screen.getByRole("combobox", { name: "Repeats" })).toBeInTheDocument();
    await pick(user, "Every", "6 hours");
    expect(await submitted()).toMatchObject({ cron: "0 */6 * * *", scheduleText: "Every 6 hours" });
  });

  it("writes the picked cadence as cron and text, in the reader's timezone, then opens it", async () => {
    const user = renderPage();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Digest" } });
    await pick(user, "Frequency", "Weekdays");
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "07:30" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Summarize the news" } });
    fireEvent.click(screen.getByRole("button", { name: "Create schedule" }));

    await waitFor(() => expect(vi.mocked(createSchedule)).toHaveBeenCalledOnce());
    expect(vi.mocked(createSchedule).mock.calls[0]![0].data).toMatchObject({
      name: "Digest",
      scheduleText: "Every weekday at 07:30",
      cron: "30 7 * * 1-5",
      prompt: "Summarize the news",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/schedules/$scheduleId",
        params: { scheduleId: "s-new" },
      }),
    );
  });
});
