import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { describe, expect, it, vi } from "vitest";
import { AnalyticsPage } from "./analytics-page.tsx";

vi.mock("~/modules/analytics/server/functions.ts", () => ({
  getUsageAnalytics: vi.fn(),
  getMyUsage: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...rest }: Record<string, unknown> & { children?: unknown }) => (
    <a href={String(to)} {...(rest as object)}>
      {children as never}
    </a>
  ),
  useMatches: () => [{ pathname: "/admin/analytics" }],
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));

// The chart library needs real layout/pointer plumbing jsdom doesn't have;
// the browser pass covers real rendering. This test is about the numbers.
vi.mock("@tanstack/charts/react", () => ({
  Chart: ({ ariaLabel }: { ariaLabel: string }) => <svg role="img" aria-label={ariaLabel} />,
}));

const data = {
  summary: {
    messages: 42,
    inputTokens: 1_200_000,
    outputTokens: 300_000,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    cost: 1.25,
    costComplete: true,
    activeUsers: 3,
  },
  daily: [
    { day: "2026-08-22", messages: 42, inputTokens: 1_200_000, outputTokens: 300_000, cost: 1.25 },
  ],
  byModel: [
    { modelName: "Fast One", messages: 30, inputTokens: 900_000, outputTokens: 200_000, cost: 1 },
    {
      modelName: "Slow One",
      messages: 12,
      inputTokens: 300_000,
      outputTokens: 100_000,
      cost: 0.25,
    },
  ],
  // Deliberately different numbers from the summary so text queries in the
  // tests hit exactly one element.
  byUser: [
    {
      userId: "u1",
      name: "Nico",
      email: "nico@example.com",
      messages: 40,
      inputTokens: 800_000,
      outputTokens: 150_000,
      cost: 0.95,
    },
  ],
};

const renderPage = (override?: Partial<typeof data>) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["admin", "analytics", 30], { ...data, ...override });
  return render(
    <QueryClientProvider client={client}>
      <Suspense fallback={null}>
        <AnalyticsPage />
      </Suspense>
    </QueryClientProvider>,
  );
};

describe("AnalyticsPage", () => {
  it("shows the KPI tiles from the summary", async () => {
    renderPage();
    // "Messages"/"42" recur in the tables below; the KPI row renders first,
    // so the first match is the tile.
    const messagesTile = (await screen.findAllByText("Messages"))[0]!.parentElement!;
    expect(messagesTile).toHaveTextContent("42");
    expect(screen.getByText("1.5M")).toBeInTheDocument();
    expect(screen.getByText("1.2M in / 300K out")).toBeInTheDocument();
    expect(screen.getByText("$1.25")).toBeInTheDocument();
    expect(screen.getByText("Active users")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("mounts all three charts through the stubbed renderer", async () => {
    renderPage();
    expect(
      await screen.findByRole("img", { name: "Tokens per day, input and output" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Messages per day" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Total tokens by model" })).toBeInTheDocument();
  });

  it("renders the model and user tables with formatted values", async () => {
    renderPage();
    expect(await screen.findByText("Fast One")).toBeInTheDocument();
    expect(screen.getByText("1.1M")).toBeInTheDocument(); // 900K + 200K
    expect(screen.getByText("Nico (nico@example.com)")).toBeInTheDocument();
  });

  it("replaces the whole body with an empty state when the range has no events", async () => {
    renderPage({
      summary: {
        ...data.summary,
        messages: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        activeUsers: 0,
      },
      daily: [],
      byModel: [],
      byUser: [],
    });
    expect(await screen.findByText("No usage in this range")).toBeInTheDocument();
    // No zero-value tiles or empty charts behind it.
    expect(screen.queryByText("Tokens")).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Messages per day" })).not.toBeInTheDocument();
    // The range select stays usable to widen the window.
    expect(screen.getByLabelText("Date range")).toBeInTheDocument();
  });

  it("shows an em dash and a floor hint when cost is incomplete", async () => {
    renderPage({
      summary: { ...data.summary, cost: 0, costComplete: false },
    });
    expect(await screen.findByText("—")).toBeInTheDocument();

    renderPage({
      summary: { ...data.summary, cost: 0.5, costComplete: false },
    });
    expect(await screen.findByText("$0.5")).toBeInTheDocument();
    expect(screen.getByText("at least — some costs unknown")).toBeInTheDocument();
  });
});
