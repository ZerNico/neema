import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import type { ScheduleSummary } from "../schema.ts";
import { deleteSchedule, listSchedules, pauseSchedule, resumeSchedule } from "../server/functions.ts";
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
  Link: ({
    to,
    params,
    children,
    ...rest
  }: Record<string, unknown> & { children?: unknown }) => (
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
        <ConfirmProvider>
          <SchedulesPage />
        </ConfirmProvider>
      </QueryClientProvider>,
    ),
  };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SchedulesPage", () => {
  it("shows each cadence with its next run and a paused badge where relevant", () => {
    renderPage([
      schedule({ id: "s1", name: "Digest" }),
      schedule({ id: "s2", name: "Retro", paused: true, nextFireAt: null }),
      schedule({ id: "s3", name: "Done", nextFireAt: null }),
    ]);
    expect(screen.getByText(/every weekday at 7am · Next run/)).toBeInTheDocument();
    expect(screen.getByText(/every weekday at 7am · Paused/)).toBeInTheDocument();
    expect(screen.getByText(/every weekday at 7am · No upcoming run/)).toBeInTheDocument();
    // Only the paused row wears the badge; "No upcoming run" is not paused.
    expect(screen.getAllByText("Paused")).toHaveLength(1);
  });

  it("pauses a live schedule and resumes a paused one through their own server functions", async () => {
    vi.mocked(pauseSchedule).mockResolvedValue(undefined);
    vi.mocked(resumeSchedule).mockResolvedValue(undefined);
    renderPage([schedule({ id: "s1", name: "Digest" }), schedule({ id: "s2", name: "Retro", paused: true })]);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() =>
      expect(vi.mocked(pauseSchedule)).toHaveBeenCalledWith({ data: { scheduleId: "s1" } }),
    );
    // Both toggles share the pending state, so wait for the first to settle.
    await waitFor(() => expect(screen.getByRole("button", { name: "Resume" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() =>
      expect(vi.mocked(resumeSchedule)).toHaveBeenCalledWith({ data: { scheduleId: "s2" } }),
    );
  });

  it("links Edit to the schedule page and deletes only after confirmation", async () => {
    vi.mocked(deleteSchedule).mockResolvedValue(undefined);
    renderPage([schedule({ id: "s1", name: "Digest" })]);
    fireEvent.click(screen.getByRole("button", { name: "Actions for Digest" }));
    expect(screen.getByRole("menuitem", { name: /^Edit$/ })).toHaveAttribute(
      "data-schedule-id",
      "s1",
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete/ }));
    expect(await screen.findByText(/past run conversations are deleted with it/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByText(/past run conversations/)).not.toBeInTheDocument(),
    );
    expect(vi.mocked(deleteSchedule)).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Actions for Digest" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete schedule" }));
    await waitFor(() =>
      expect(vi.mocked(deleteSchedule)).toHaveBeenCalledWith({ data: { scheduleId: "s1" } }),
    );
  });

  it("offers creation through chat when there is nothing yet", () => {
    renderPage([]);
    expect(screen.getByText("No schedules yet")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /New schedule/ }).length).toBeGreaterThan(0);
  });
});
