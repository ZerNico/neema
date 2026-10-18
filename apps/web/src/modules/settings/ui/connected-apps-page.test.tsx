import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense } from "react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { ConnectedAppsPage } from "./connected-apps-page.tsx";

vi.mock("~/modules/mcp-server/server/functions.ts", () => ({
  listConnectedApps: vi.fn(),
  revokeConnectedApp: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children?: unknown }) => (
    <a href={to}>{children as never}</a>
  ),
}));

const renderPage = (serverUrl: string | null) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["connected-apps"], { apps: [], allowed: true, serverUrl });
  render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <Suspense fallback={null}>
          <ConnectedAppsPage />
        </Suspense>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
};

describe("ConnectedAppsPage", () => {
  it("shows how to set each kind of client up, with this instance's address", async () => {
    const user = userEvent.setup();
    renderPage("https://chat.example/api/mcp");
    expect(
      screen.getByText("claude mcp add --transport http neema https://chat.example/api/mcp"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "With an API key" }));
    expect(screen.getByText(/"Authorization": "Bearer nma_…"/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "API keys" })).toHaveAttribute(
      "href",
      "/settings/api-keys",
    );
  });

  it("offers no setup while the instance has no address apps can reach", () => {
    renderPage(null);
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });
});
