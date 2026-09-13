import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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
  it("offers the range picker even when the range holds no usage", () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    client.setQueryData(["test-usage"], { daily: [] });
    render(
      <QueryClientProvider client={client}>
        <UsagePage />
      </QueryClientProvider>,
    );
    expect(screen.getByText("No usage in this range")).toBeVisible();
    expect(screen.queryByText("Usage overview")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Date range" })).toBeVisible();
  });
});
