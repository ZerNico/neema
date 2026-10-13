import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense } from "react";
import { describe, expect, it, vi } from "vitest";
import { AnalyticsPage } from "./analytics-page.tsx";
import { getUsageAnalytics } from "~/modules/analytics/server/functions.ts";
import { adminUsageQuery } from "~/modules/analytics/client/queries.ts";
import { DEFAULT_USAGE_RANGE } from "~/modules/analytics/schema.ts";

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

const summary = {
  messages: 42,
  attempts: 60,
  titleGenerations: 12,
  compactionGenerations: 6,
  imageGenerations: 0,
  images: 0,
  errorAttempts: 3,
  abortedAttempts: 2,
  inputTokens: 1_200_000,
  outputTokens: 300_000,
  cachedInputTokens: 600_000, // half of input, a clean 50% hit rate
  cacheWriteTokens: 0,
  reasoningTokens: 100_000,
  cost: 1.25,
  costComplete: true,
  activeUsers: 3,
};

const data = {
  summary,
  /**
   * The baseline the deltas are measured against. Chosen so each tile lands on
   * a distinct, hand-checkable number rather than a shared round one.
   */
  previousSummary: {
    ...summary,
    messages: 21, // → +100%
    attempts: 50,
    errorAttempts: 5, // 10% → 5%, i.e. −5.0pp
    inputTokens: 600_000,
    outputTokens: 150_000,
    cachedInputTokens: 150_000, // 25% → 50%, i.e. +25.0pp
    cost: 1,
    activeUsers: 3,
  },
  window: { from: "2026-08-22T00:00:00.000Z", to: "2026-08-23T00:00:00.000Z" },
  daily: [
    {
      day: "2026-08-22",
      messages: 42,
      images: 0,
      attempts: 60,
      errorAttempts: 3,
      inputTokens: 1_200_000,
      outputTokens: 300_000,
      cachedInputTokens: 600_000,
      reasoningTokens: 100_000,
      cost: 1.25,
    },
  ],
  byModel: [
    {
      modelName: "Fast One",
      linked: true,
      messages: 30,
      images: 0,
      inputTokens: 900_000,
      outputTokens: 200_000,
      cost: 1,
      costComplete: true,
    },
    {
      modelName: "Slow One",
      linked: true,
      messages: 12,
      images: 0,
      inputTokens: 300_000,
      outputTokens: 100_000,
      cost: 0.25,
      costComplete: true,
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
      images: 0,
      inputTokens: 800_000,
      outputTokens: 150_000,
      cost: 0.95,
      costComplete: true,
    },
  ],
};

// The range trigger carries no aria-label: its visible text is the active
// range, so it is found by that text (same handle as usage-dashboard.test).
const rangeTrigger = () => screen.getByRole("button", { name: /Last \d+ days|–/ });

const renderPage = (override?: Partial<typeof data>) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(adminUsageQuery(DEFAULT_USAGE_RANGE).queryKey, { ...data, ...override });
  return render(
    <QueryClientProvider client={client}>
      <Suspense fallback={<div>Loading analytics</div>}>
        <AnalyticsPage />
      </Suspense>
    </QueryClientProvider>,
  );
};

describe("AnalyticsPage", () => {
  it("qualifies grouped costs for models and users without confusing unknown with free", async () => {
    const costs = [
      { label: "Complete", cost: 1.25, costComplete: true, text: "$1.25" },
      { label: "Partial", cost: 1.25, costComplete: false, text: "At least $1.25 (partial)" },
      { label: "Free", cost: 0, costComplete: true, text: "$0" },
      { label: "Unknown", cost: 0, costComplete: false, text: "Unknown" },
    ];
    renderPage({
      byModel: costs.map((row) => ({
        ...data.byModel[0]!,
        modelName: `Model ${row.label}`,
        cost: row.cost,
        costComplete: row.costComplete,
      })),
      byUser: costs.map((row) => ({
        ...data.byUser[0]!,
        userId: row.label,
        name: `User ${row.label}`,
        cost: row.cost,
        costComplete: row.costComplete,
      })),
    });
    for (const cost of costs) {
      for (const prefix of ["Model", "User"]) {
        const row = await screen.findByRole("row", {
          name: new RegExp(`^${prefix} ${cost.label} `),
        });
        const cells = within(row).getAllByRole("cell");
        expect(cells.at(-1)?.textContent).toBe(cost.text);
      }
    }
  });
  it("marks a deleted model only where a current model shares its name", async () => {
    renderPage({
      byModel: [
        { ...data.byModel[0]!, modelName: "Shared", linked: true },
        { ...data.byModel[0]!, modelName: "Shared", linked: false },
        { ...data.byModel[0]!, modelName: "Mistral OCR", linked: false },
      ],
    });
    expect(await screen.findByRole("row", { name: /^Shared 30 / })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /^Shared \(deleted\) / })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /^Mistral OCR 30 / })).toBeInTheDocument();
  });
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

  it("composes KPI tiles and chart panels from shared cards", async () => {
    renderPage();

    const messagesLabel = (await screen.findAllByText("Messages"))[0]!;
    const chartTitle = await screen.findByRole("heading", { name: "What used tokens" });
    expect(messagesLabel.closest('[data-slot="card-content"]')).toHaveTextContent("42");
    expect(chartTitle.closest('[data-slot="card-header"]')).not.toBeNull();
    for (const content of [messagesLabel, chartTitle]) {
      expect(content.closest('[data-slot="card"]')).toHaveAttribute("data-size", "sm");
    }
  });

  it("keeps the current dashboard visible while another range loads", async () => {
    // Never resolve the uncached 7-day query: if the range update is not a
    // transition, the route's Suspense fallback replaces the whole page.
    vi.mocked(getUsageAnalytics).mockImplementation(() => new Promise(() => {}) as never);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("1.5M")).toBeInTheDocument();
    await user.click(rangeTrigger());
    await user.click(screen.getByText("Last 7 days"));

    expect(screen.getByText("1.5M")).toBeInTheDocument();
    expect(screen.queryByText("Loading analytics")).not.toBeInTheDocument();
  });

  it("mounts all three charts through the stubbed renderer", async () => {
    renderPage();
    expect(
      await screen.findByRole("img", {
        name: "What used tokens per day: input, cached, output and reasoning",
      }),
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
        ...summary,
        messages: 0,
        attempts: 0,
        titleGenerations: 0,
        compactionGenerations: 0,
        imageGenerations: 0,
        images: 0,
        errorAttempts: 0,
        abortedAttempts: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
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
    expect(rangeTrigger()).toBeInTheDocument();
  });

  it("shows a placeholder dash and a floor hint when cost is incomplete", async () => {
    renderPage({
      summary: { ...summary, cost: 0, costComplete: false },
    });
    // Cost and blended rate both suppress; cache/error rates still resolve.
    expect((await screen.findAllByText("–")).length).toBeGreaterThan(0);

    renderPage({
      summary: { ...summary, cost: 0.5, costComplete: false },
    });
    expect(await screen.findByText("$0.5")).toBeInTheDocument();
    expect(screen.getByText("at least, some costs unknown")).toBeInTheDocument();
  });

  it("states counts in percent and rates in points", async () => {
    renderPage();
    // Messages doubled: a count, so relative percent.
    expect((await screen.findAllByText("+100%")).length).toBeGreaterThan(0);
    // Reused text 25% → 50%. As a relative change that reads "+100%",
    // which is why rates move in points instead.
    expect(screen.getByText("+25.0pp")).toBeInTheDocument();
    // Error rate 10% → 5%: down, and a minus sign rather than a hyphen.
    expect(screen.getByText("\u22125.0pp")).toBeInTheDocument();
  });

  it("derives the cache, blended-cost and error KPIs", async () => {
    renderPage();
    expect(await screen.findByText("Reused text")).toBeInTheDocument();
    // 600K cached of 1.2M input. Cached is *inside* input, not added to it,
    // so the wrong formula would give 33%.
    expect(screen.getByText("50%")).toBeInTheDocument();
    // $1.25 over 1.5M tokens.
    expect(screen.getByText("$0.833/M")).toBeInTheDocument();
    // 3 of 60 attempts, spanning chat and title runs alike.
    expect(screen.getByText("5%")).toBeInTheDocument();
    expect(screen.getByText("3 failed · 2 stopped · 60 tries")).toBeInTheDocument();
  });

  it("suppresses the blended rate when any cost in range is unknown", async () => {
    renderPage({ summary: { ...summary, costComplete: false } });
    const tile = (await screen.findAllByText("Cost per 1M tokens"))[0]!.parentElement!;
    expect(tile).toHaveTextContent("–");
    expect(tile).not.toHaveTextContent("/M");
  });

  it("breaks tokens into four mutually exclusive parts", async () => {
    renderPage();
    // Input is *net* of cached and output net of reasoning, so the four
    // numbers sum to the 1.5M total rather than double-counting.
    expect((await screen.findAllByText("600K")).length).toBeGreaterThan(0); // uncached input
    expect(screen.getByText("200K")).toBeInTheDocument(); // text output
    expect(screen.getByText("100K")).toBeInTheDocument(); // reasoning
  });

  it("splits chat from title and compaction generations", async () => {
    renderPage();
    expect(await screen.findByText("What ran")).toBeInTheDocument();
    // 42 chat + 12 title + 6 compaction = 60 attempts → 70/20/10.
    expect(screen.getByText(/70%/)).toBeInTheDocument();
    expect(screen.getByText(/20%/)).toBeInTheDocument();
    expect(screen.getByText(/10%/)).toBeInTheDocument();
    expect(screen.getByText("summarizing", { exact: false })).toBeInTheDocument();
  });
});
