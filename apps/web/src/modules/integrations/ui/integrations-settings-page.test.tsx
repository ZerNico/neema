import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { myIntegrationsQuery } from "../client/queries.ts";
import { outlineManifest } from "../outline/manifest.ts";
import type { UserIntegration } from "../schema.ts";
import {
  connectIntegrationApiKey,
  connectIntegrationOpen,
  updateIntegrationConnection,
} from "../server/functions.ts";
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
  connectIntegrationOpen: vi.fn(async () => ({ ok: true })),
  listIntegrationScopeOptions: vi.fn(async () => ({
    ok: true,
    options: [
      { id: "PROJ", label: "Product", detail: "PROJ" },
      { id: "OPS", label: "Operations", detail: "OPS" },
    ],
  })),
}));

const outline = (connection: Partial<UserIntegration["connection"]> | null): UserIntegration => ({
  id: "outline",
  kind: "outline",
  name: "Outline",
  available: true,
  methods: { oauth: true, apiKey: true, open: null, everyone: false },
  tools: outlineManifest.tools.map(({ name, title, label, description, access }) => ({
    name,
    title,
    label,
    description,
    access,
  })),
  apiKeyHelpUrl: null,
  connection: connection && {
    id: "connection-1",
    authKind: "oauth",
    accountLabel: "ada@example.com · Example workspace",
    status: "active",
    offerByDefault: true,
    toolPermissions: {},
    scope: null,
    requiredScopes: null,
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

  it("lets a person turn an open server on again after the admin changed it", async () => {
    mount({
      ...outline({ authKind: "none", accountLabel: "No sign-in needed", status: "needs_reauth" }),
      methods: { oauth: false, apiKey: false, open: "none", everyone: false },
    });
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.queryByText("Signed out")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Turn on again" }));
    await waitFor(() =>
      expect(connectIntegrationOpen).toHaveBeenCalledWith({ data: { integrationId: "outline" } }),
    );
  });

  it("offers no Disconnect for a server an admin turned on for everyone", async () => {
    mount({
      ...outline({ authKind: "none", accountLabel: "Docs" }),
      methods: { oauth: false, apiKey: false, open: "none", everyone: true },
    });
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Account actions" })).toBeNull();
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
    mount({ ...outline(null), id: "jira", kind: "jira", name: "Jira" });
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

  it("limits a connection to the projects picked", async () => {
    const user = userEvent.setup();
    mount({ ...outline({}), id: "jira", kind: "jira", name: "Jira" });
    vi.mocked(updateIntegrationConnection).mockResolvedValue({ ok: true });
    expect(screen.getByRole("radio", { name: "All projects" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "Only selected projects" }));
    // The choice is saved at once; with nothing ticked the connection reaches nothing.
    await waitFor(() =>
      expect(updateIntegrationConnection).toHaveBeenLastCalledWith({
        data: { integrationId: "jira", scope: [] },
      }),
    );
    expect(screen.getByText("None selected")).toBeInTheDocument();
    await user.click(await screen.findByRole("checkbox", { name: /Operations/ }));
    await waitFor(() =>
      expect(updateIntegrationConnection).toHaveBeenLastCalledWith({
        data: { integrationId: "jira", scope: ["OPS"] },
      }),
    );
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "All projects" }));
    await waitFor(() =>
      expect(updateIntegrationConnection).toHaveBeenLastCalledWith({
        data: { integrationId: "jira", scope: null },
      }),
    );
  });
});
