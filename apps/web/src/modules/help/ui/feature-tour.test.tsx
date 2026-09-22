import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { seenFeaturesQuery } from "../client/queries.ts";
import { FEATURE_KEYS } from "../features.ts";
import { listSeenFeatures, markFeaturesSeen } from "../server/functions.ts";
import { FeatureTourProvider } from "./feature-tour.tsx";
import { HelpPage } from "./help-page.tsx";

vi.mock("../server/functions.ts", () => ({
  listSeenFeatures: vi.fn(),
  markFeaturesSeen: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    onClick,
    className,
  }: {
    to: string;
    children: React.ReactNode;
    onClick?: () => void;
    className?: string;
  }) => (
    <a href={to} onClick={onClick} className={className}>
      {children}
    </a>
  ),
}));
vi.stubGlobal(
  "matchMedia",
  vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
);

const renderTour = (seen: string[], { enabled = true, help = false } = {}) => {
  vi.mocked(listSeenFeatures).mockResolvedValue(seen);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <FeatureTourProvider enabled={enabled}>
        {help ? <HelpPage /> : <p>app</p>}
      </FeatureTourProvider>
    </QueryClientProvider>,
  );
  return client;
};

beforeEach(() => vi.clearAllMocks());

describe("FeatureTourProvider", () => {
  it("welcomes someone new through every feature and remembers a skip", async () => {
    renderTour([]);
    expect(await screen.findByText(`Welcome to neema · 1 of ${FEATURE_KEYS.length}`)).toBeVisible();
    expect(screen.getByRole("heading", { name: "Agents" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "Knowledge" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() =>
      expect(markFeaturesSeen).toHaveBeenCalledWith({ data: { keys: [...FEATURE_KEYS] } }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("shows only what was added since, as new", async () => {
    renderTour(FEATURE_KEYS.filter((key) => key !== "memory"));
    expect(await screen.findByText("New in neema")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Memory" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Skip" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(markFeaturesSeen).toHaveBeenCalledWith({ data: { keys: ["memory"] } }),
    );
  });

  it("stays out of the way once everything has been seen", async () => {
    const client = renderTour([...FEATURE_KEYS]);
    // The answer has landed, so the tour has had its chance to open.
    await waitFor(() => expect(client.getQueryData(seenFeaturesQuery.queryKey)).toBeDefined());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not ask while an admin is impersonating", () => {
    renderTour([], { enabled: false });
    expect(listSeenFeatures).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("lists every feature on Help and replays the tour without marking anything", async () => {
    renderTour([...FEATURE_KEYS], { help: true });
    expect(screen.getByRole("heading", { name: "Schedules" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Open Memory" })).toHaveAttribute(
      "href",
      "/settings/memory",
    );
    fireEvent.click(screen.getByRole("button", { name: "Show the tour again" }));
    expect(await screen.findByText(`Welcome to neema · 1 of ${FEATURE_KEYS.length}`)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(markFeaturesSeen).not.toHaveBeenCalled();
  });
});
