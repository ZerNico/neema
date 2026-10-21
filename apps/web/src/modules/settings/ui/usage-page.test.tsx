import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UsagePage } from "./usage-page.tsx";
vi.mock("~/modules/analytics/client/queries.ts", () => ({
  myUsageQuery: () => ({ queryKey: ["test-usage"], queryFn: vi.fn() }),
}));
vi.mock("~/modules/limits/client/queries.ts", () => ({
  myLimitsQuery: { queryKey: ["test-limits"], queryFn: () => [] },
}));
vi.mock("~/modules/analytics/ui/usage-dashboard.tsx", () => ({
  UsageRangePicker: () => <button>Date range</button>,
  UsageOverview: () => <div>Usage overview</div>,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="/settings">{children}</a>,
}));
describe("UsagePage", () => {
  it("offers the range picker even when the range holds no usage", () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    client.setQueryData(["test-usage"], { daily: [] });
    client.setQueryData(["test-limits"], []);
    render(
      <QueryClientProvider client={client}>
        <UsagePage />
      </QueryClientProvider>,
    );
    expect(screen.getByText("No usage in this range")).toBeVisible();
    // Nobody is held to anything, so there is no limits section.
    expect(screen.queryByText("Limits")).not.toBeInTheDocument();
    expect(screen.queryByText("Usage overview")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Date range" })).toBeVisible();
  });

  it("shows each limit with what is used of it, and nothing when there are none", () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    client.setQueryData(["test-usage"], { daily: [] });
    client.setQueryData(
      ["test-limits"],
      [
        {
          metric: "cost",
          period: "month",
          amount: 10,
          used: 3.2,
          models: null,
          resetsAt: "2026-11-01T00:00:00.000Z",
          reached: false,
        },
        {
          metric: "answers",
          period: "day",
          amount: 20,
          used: 20,
          models: [{ id: "opus", name: "Claude Opus" }],
          resetsAt: "2026-10-22T00:00:00.000Z",
          reached: true,
        },
      ],
    );
    render(
      <QueryClientProvider client={client}>
        <UsagePage />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Limits")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "$3.20 of $10.00 this month" })).toBeVisible();
    expect(screen.getByText(/Claude Opus/)).toBeVisible();
    expect(screen.getByText(/Used up/)).toBeVisible();
  });
});
