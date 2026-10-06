import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { myIntegrationsQuery } from "../client/queries.ts";
import type { UserIntegration } from "../schema.ts";
import { connectIntegrationApiKey } from "../server/functions.ts";
import { IntegrationSettingsPage } from "./integrations-settings-page.tsx";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children?: unknown }) => (
    <a href={to}>{children as never}</a>
  ),
}));
vi.mock("../server/functions.ts", () => ({
  disconnectIntegration: vi.fn(),
  updateIntegrationConnection: vi.fn(),
  connectIntegrationApiKey: vi.fn(),
}));

const outline = (connection: Partial<UserIntegration["connection"]> | null): UserIntegration => ({
  id: "outline",
  available: true,
  methods: { oauth: true, apiKey: true },
  apiKeyHelpUrl: null,
  connection: connection && {
    id: "connection-1",
    authKind: "oauth",
    accountLabel: "ada@example.com · Example workspace",
    status: "active",
    offerByDefault: true,
    toolPermissions: {},
    createdAt: "2026-09-24T10:00:00Z",
    ...connection,
  },
  dependents: { sources: 0, schedules: 0 },
});

const mount = (integration: UserIntegration) => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(myIntegrationsQuery.queryKey, [integration]);
  render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <IntegrationSettingsPage integrationId={integration.id} />
      </ConfirmProvider>
    </QueryClientProvider>,
  );
};

describe("integration account row", () => {
  it("offers one way back in for a lapsed sign-in, the rest in its menu", async () => {
    mount(outline({ status: "needs_reauth" }));
    expect(screen.getByText("Signed out")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Reconnect" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Use an API key" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Account actions" }));
    expect(await screen.findByRole("menuitem", { name: "Use an API key instead" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Disconnect" })).toBeVisible();
    fireEvent.click(screen.getByRole("menuitem", { name: "Use an API key instead" }));
    const dialog = await screen.findByRole("dialog", { name: "Connect Outline with an API key" });
    // The manifest's fields are the form, and their values are what is sent.
    const connect = within(dialog).getByRole("button", { name: "Connect" });
    expect(connect).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("API key"), {
      target: { value: "ol_api_x" },
    });
    vi.mocked(connectIntegrationApiKey).mockResolvedValue({ ok: true });
    fireEvent.click(connect);
    await waitFor(() =>
      expect(connectIntegrationApiKey).toHaveBeenCalledWith({
        data: { integrationId: "outline", values: { key: "ol_api_x" } },
      }),
    );
  });

  it("keeps a working connection's row to its account and a menu", async () => {
    mount(outline({}));
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Reconnect|Sign in/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Account actions" }));
    expect(await screen.findByRole("menuitem", { name: "Disconnect" })).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: "Use an API key instead" })).toBeNull();
  });

  it("shows both ways to connect before there is an account", () => {
    mount(outline(null));
    expect(screen.getByRole("button", { name: "Use an API key" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in with Outline" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Account actions" })).not.toBeInTheDocument();
  });

  it("asks for every field the integration's API key needs", async () => {
    mount({ ...outline(null), id: "jira" });
    fireEvent.click(screen.getByRole("button", { name: "Use an API key" }));
    const dialog = await screen.findByRole("dialog", { name: "Connect Jira with an API key" });
    const connect = within(dialog).getByRole("button", { name: "Connect" });
    fireEvent.change(within(dialog).getByLabelText("API token"), { target: { value: "t0k" } });
    // The token alone is not enough for Jira.
    expect(connect).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Atlassian account email"), {
      target: { value: "me@acme.test" },
    });
    vi.mocked(connectIntegrationApiKey).mockResolvedValue({ ok: true });
    fireEvent.click(connect);
    await waitFor(() =>
      expect(connectIntegrationApiKey).toHaveBeenCalledWith({
        data: { integrationId: "jira", values: { email: "me@acme.test", token: "t0k" } },
      }),
    );
  });
});
