import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduleSummary } from "../schema.ts";
import { listSchedules } from "../server/functions.ts";
import { SchedulesPage } from "./schedules-page.tsx";

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
  previewSchedule: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children, ...rest }: Record<string, unknown> & { children?: unknown }) => (
    <a
      href={String(to)}
      data-schedule-id={(params as { scheduleId?: string } | undefined)?.scheduleId}
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

const schedule = (overrides: Partial<ScheduleSummary> & { id: string }): ScheduleSummary => ({
  name: "Digest",
  scheduleText: "every weekday at 7am",
  cron: "0 7 * * 1-5",
  timezone: "UTC",
  paused: false,
  nextFireAt: new Date(Date.now() + 3_600_000).toISOString(),
  lastFiredAt: null,
  ...overrides,
});
const renderPage = (rows: ScheduleSummary[]) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["schedules"], rows);
  // Mutations invalidate the list, so the refetch has to answer too.
  vi.mocked(listSchedules).mockResolvedValue(rows);
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <SchedulesPage />
      </QueryClientProvider>,
    ),
  };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SchedulesPage", () => {
  it("names each cadence from its cron, with the next run and a paused badge", () => {
    renderPage([
      schedule({ id: "s1", name: "Digest" }),
      schedule({ id: "s2", name: "Retro", paused: true, nextFireAt: null }),
      schedule({ id: "s3", name: "Done", nextFireAt: null }),
    ]);
    expect(screen.getByText(/^Every weekday at 07:00 · Next run/)).toBeInTheDocument();
    expect(screen.getByText(/^Every weekday at 07:00 · No upcoming run/)).toBeInTheDocument();
    // Paused says so once, as the badge, not again in the line.
    expect(screen.getAllByText("Paused")).toHaveLength(1);
    expect(screen.getByText(/^Every weekday at 07:00$/)).toBeInTheDocument();
  });

  it("counts a long day list and keeps the author's words for a cron it cannot read", () => {
    renderPage([
      schedule({ id: "s1", name: "Many", cron: "45 9 3,4,6,8,9,L * *" }),
      schedule({ id: "s2", name: "Odd", cron: "0 7-9 * * *", scheduleText: "mornings" }),
    ]);
    expect(screen.getByText(/^Every month on 6 days at 09:45 · /)).toBeInTheDocument();
    expect(screen.getByText(/^mornings · /)).toBeInTheDocument();
  });

  it("opens a schedule from its whole row", () => {
    renderPage([schedule({ id: "s1", name: "Digest" })]);
    expect(screen.getByRole("link", { name: "Open Digest" })).toHaveAttribute(
      "data-schedule-id",
      "s1",
    );
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
  });

  it("offers creation through chat, or by hand from the menu, when there is nothing yet", async () => {
    renderPage([]);
    expect(screen.getByText("No schedules yet")).toBeInTheDocument();
    const [chat] = screen.getAllByRole("link", { name: "New schedule" });
    expect(chat).toHaveAttribute("href", "/");
    const [menu] = screen.getAllByRole("button", { name: "More ways to create: New schedule" });
    fireEvent.click(menu!);
    expect(await screen.findByRole("menuitem", { name: "Set up manually" })).toHaveAttribute(
      "href",
      "/schedules/new",
    );
  });
});
