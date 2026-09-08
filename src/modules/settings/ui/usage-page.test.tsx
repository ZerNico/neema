import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UsagePage } from "./usage-page.tsx";
vi.mock("~/modules/analytics/client/queries.ts", () => ({
  myUsageQuery: () => ({ queryKey: ["test-usage"], queryFn: vi.fn() }),
}));
vi.mock("~/modules/analytics/ui/usage-dashboard.tsx", () => ({
  UsageRangePicker: () => <button>Date range</button>,
  UsageOverview: () => <div>Usage overview</div>,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="/settings">{children}</a>,
}));
describe("UsagePage", () => {
  it("keeps accounting explanations available in a disclosure", () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    client.setQueryData(["test-usage"], { daily: [] });
    render(
      <QueryClientProvider client={client}>
        <UsagePage />
      </QueryClientProvider>,
    );
    expect(screen.getByText("No usage in this range")).toBeVisible();
    expect(
      screen.queryByText(/missing cost information is not free usage/),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "About usage" }));
    expect(screen.getByText(/Usage includes retries and title generations/)).toBeVisible();
    expect(screen.getByText(/missing cost information is not free usage/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Date range" })).toBeVisible();
  });
});
