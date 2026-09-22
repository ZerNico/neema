import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { describe, expect, it, vi } from "vitest";
import type { CustomToolSummary } from "../schema.ts";
import { CustomToolsPage } from "./custom-tools-page.tsx";

vi.mock("../server/functions.ts", () => ({ listCustomTools: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    children,
    className,
  }: {
    to: string;
    params?: Record<string, string>;
    children?: React.ReactNode;
    className?: string;
  }) => (
    <a
      href={Object.entries(params ?? {}).reduce((path, [k, v]) => path.replace(`$${k}`, v), to)}
      className={className}
    >
      {children}
    </a>
  ),
  useMatches: () => [{ pathname: "/admin/custom-tools" }],
}));

const tool = (overrides: Partial<CustomToolSummary> = {}): CustomToolSummary => ({
  id: "t1",
  slug: "weather_lookup",
  name: "Weather lookup",
  description: "Current weather for a city.",
  enabled: true,
  audience: "instance",
  version: "v1",
  functionCount: 2,
  dependencyCount: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const renderPage = (tools: CustomToolSummary[]) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["admin", "custom-tools"], tools);
  render(
    <QueryClientProvider client={client}>
      <Suspense fallback={null}>
        <CustomToolsPage />
      </Suspense>
    </QueryClientProvider>,
  );
};

describe("CustomToolsPage", () => {
  it("links each module to its page with its access and state", () => {
    renderPage([tool(), tool({ id: "t2", name: "Ops", audience: "private", enabled: false })]);
    const rows = screen.getAllByRole("link", { name: /Weather lookup|Ops/ });
    expect(rows[0]).toHaveAttribute("href", "/admin/custom-tools/t1");
    expect(rows[0]).not.toHaveTextContent("Private");
    expect(rows[0]).toHaveTextContent("weather_lookup · 2 functions · 1 dependency");
    expect(rows[1]).toHaveTextContent("Private");
    expect(rows[1]).toHaveTextContent("Disabled");
  });

  it("offers a new module from the empty state", () => {
    renderPage([]);
    expect(screen.getByText("No modules yet")).toBeInTheDocument();
    for (const link of screen.getAllByRole("link", { name: "New module" }))
      expect(link).toHaveAttribute("href", "/admin/custom-tools/new");
  });
});
