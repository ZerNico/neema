import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { myIntegrationsQuery, personalServersQuery } from "../client/queries.ts";
import { outlineManifest } from "../outline/manifest.ts";
import type { IntegrationConnectionView, PersonalServers, UserIntegration } from "../schema.ts";
import {
  connectIntegrationApiKey,
  connectIntegrationOpen,
  savePersonalServer,
  updateIntegrationConnection,
} from "../server/functions.ts";
import {
  IntegrationSettingsPage,
  IntegrationsSettingsPage,
} from "./integrations-settings-page.tsx";

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children?: unknown }) => (
    <a href={to}>{children as never}</a>
  ),
  useNavigate: () => navigate,
}));
vi.mock("../server/functions.ts", () => ({
  disconnectIntegration: vi.fn(),
  updateIntegrationConnection: vi.fn(),
  connectIntegrationApiKey: vi.fn(),
  connectIntegrationOpen: vi.fn(async () => ({ ok: true })),
  savePersonalServer: vi.fn(async () => ({ ok: false, error: "stop here" })),
  checkPersonalCatalog: vi.fn(),
  approvePersonalCatalog: vi.fn(),
  listIntegrationScopeOptions: vi.fn(async () => ({
    ok: true,
    options: [
      { id: "PROJ", label: "Product", detail: "PROJ" },
      { id: "OPS", label: "Operations", detail: "OPS" },
    ],
  })),
}));

const OUTLINE_TOOLS = outlineManifest.tools.map(({ name, title, label, description, access }) => ({
  name,
  title,
  label,
  description,
  access,
}));

const account = (patch: Partial<IntegrationConnectionView> = {}): IntegrationConnectionView => ({
  id: "connection-1",
  authKind: "oauth",
  accountLabel: "ada@example.com · Example workspace",
  name: null,
  status: "active",
  offerByDefault: true,
  toolPermissions: {},
  scope: null,
  requiredScopes: null,
  listing: null,
  tools: OUTLINE_TOOLS,
  dependents: { sources: 0, schedules: 0 },
  createdAt: "2026-09-24T10:00:00Z",
  ...patch,
});

const outline = (connection: Partial<IntegrationConnectionView> | null): UserIntegration => ({
  id: "outline",
  kind: "outline",
  name: "Outline",
  description: null,
  server: null,
  available: true,
  personal: false,
  methods: { oauth: true, apiKey: true, open: null, everyone: false },
  tools: OUTLINE_TOOLS,
  apiKeyHelpUrl: null,
  connections: connection ? [account(connection)] : [],
});

const mount = (integration: UserIntegration, servers: PersonalServers["servers"] = []) => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(myIntegrationsQuery.queryKey, [integration]);
  client.setQueryData(personalServersQuery.queryKey, { canAdd: true, servers });
  render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <IntegrationSettingsPage integrationId={integration.id} />
      </ConfirmProvider>
    </QueryClientProvider>,
  );
};

describe("integration account row", () => {
  it("reconnects a lapsed sign-in as that account, and adds another beside it", async () => {
    mount(outline({ status: "needs_reauth" }));
    expect(screen.getByText("Signed out")).toBeInTheDocument();
    // Reconnecting names the account, so the sign-in cannot land on another one.
    expect(screen.getByRole("link", { name: "Reconnect" })).toHaveAttribute(
      "href",
      "/api/integrations/outline/connect?account=connection-1",
    );
    expect(screen.getByText("Add another account")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/api/integrations/outline/connect",
    );
    fireEvent.click(screen.getByRole("button", { name: "Use an API key" }));
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

  it("names, renames and sets each account on its own", async () => {
    mount({
      ...outline({}),
      connections: [
        account({ name: "Work" }),
        account({ id: "connection-2", accountLabel: "ada@home.test", offerByDefault: false }),
      ],
    });
    expect(screen.getByRole("heading", { name: "Accounts" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Work" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "ada@home.test" })).toBeInTheDocument();
    expect(screen.getByText("Name it to tell your accounts apart.")).toBeInTheDocument();
    vi.mocked(updateIntegrationConnection).mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "Actions for ada@home.test" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename account" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: " Home " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updateIntegrationConnection).toHaveBeenLastCalledWith({
        data: { connectionId: "connection-2", name: "Home" },
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
    expect(screen.queryByRole("button", { name: /^Actions for/ })).toBeNull();
  });

  it("shows one's own server by its address, with its tools and menu", async () => {
    mount({ ...outline({ authKind: "none", accountLabel: "Mine" }), personal: true }, [
      {
        id: "outline",
        name: "Mine",
        config: { url: "https://mcp.example.com/mcp", ways: "anonymous" },
        listing: { server: null, checkedAt: null, checkError: null, count: 3 },
      },
    ]);
    expect(screen.getByText("https://mcp.example.com/mcp")).toBeInTheDocument();
    expect(screen.getByText("3 tools")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check again" })).toBeVisible();
    // Changing and removing it sit in the page's menu, as on other detail pages.
    fireEvent.click(screen.getByRole("button", { name: "Server actions" }));
    expect(await screen.findByRole("menuitem", { name: "Edit server" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Remove" })).toBeVisible();
  });

  it("keeps a working account's row to its name and a menu", async () => {
    mount(outline({}));
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Reconnect/ })).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Actions for ada@example.com · Example workspace" }),
    );
    expect(await screen.findByRole("menuitem", { name: "Disconnect" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeVisible();
  });

  it("shows both ways to connect before there is an account", () => {
    mount(outline(null));
    expect(screen.getByRole("button", { name: "Use an API key" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in with Outline" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Actions for/ })).not.toBeInTheDocument();
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
        data: { connectionId: "connection-1", scope: [] },
      }),
    );
    expect(screen.getByText("None selected")).toBeInTheDocument();
    await user.click(await screen.findByRole("checkbox", { name: /Operations/ }));
    await waitFor(() =>
      expect(updateIntegrationConnection).toHaveBeenLastCalledWith({
        data: { connectionId: "connection-1", scope: ["OPS"] },
      }),
    );
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "All projects" }));
    await waitFor(() =>
      expect(updateIntegrationConnection).toHaveBeenLastCalledWith({
        data: { connectionId: "connection-1", scope: null },
      }),
    );
  });
});

describe("integrations list", () => {
  const mountList = (
    integrations: ReadonlyArray<UserIntegration>,
    choices: { canAdd: boolean },
  ) => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    client.setQueryData(myIntegrationsQuery.queryKey, integrations);
    client.setQueryData(personalServersQuery.queryKey, { ...choices, servers: [] });
    render(
      <QueryClientProvider client={client}>
        <ConfirmProvider>
          <IntegrationsSettingsPage />
        </ConfirmProvider>
      </QueryClientProvider>,
    );
  };
  const wiki = { ...outline(null), id: "wiki", name: "Wiki" };
  const mine = {
    ...outline({ authKind: "none" }),
    id: "mcp",
    kind: "mcp",
    name: "Mine",
    personal: true,
  };

  it("lists what one connected or added, and adds the rest from one directory", async () => {
    const user = userEvent.setup();
    mountList([outline({}), wiki, mine], { canAdd: true });
    expect(screen.getByText("Outline")).toBeInTheDocument();
    expect(screen.getByText("Your own server")).toBeInTheDocument();
    // Not connected yet, so it waits in the directory.
    expect(screen.queryByText("Wiki")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Add integration" }));
    const directory = await screen.findByRole("dialog", { name: "Add integration" });
    expect(within(directory).queryByRole("button", { name: /^Outline/ })).toBeNull();
    // Known servers come from the admin like anything else, never from the catalog itself.
    expect(within(directory).queryByRole("button", { name: /^Trello/ })).toBeNull();
    // What an admin set up connects on its own page.
    await user.click(within(directory).getByRole("button", { name: /^Wiki/ }));
    expect(navigate).toHaveBeenCalledWith({
      to: "/settings/integrations/$integrationId",
      params: { integrationId: "wiki" },
    });

    // An address of one's own asks for it, and saves with what was typed.
    await user.click(screen.getByRole("button", { name: "Add integration" }));
    await user.click(screen.getByRole("button", { name: /^MCP server by address/ }));
    expect(await screen.findByLabelText(/Server address/)).toHaveValue("");
    await user.type(screen.getByLabelText("Name"), "Docs");
    await user.type(screen.getByLabelText(/Server address/), "https://mcp.example.com/mcp");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(savePersonalServer).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: "Docs",
          config: expect.objectContaining({ url: "https://mcp.example.com/mcp" }),
        }),
      }),
    );
  });

  it("offers a known server an admin added like any of theirs, and no address without leave", async () => {
    const user = userEvent.setup();
    mountList(
      [{ ...outline(null), id: "mcp-1", kind: "mcp", name: "Team Linear", server: "linear" }],
      { canAdd: false },
    );
    await user.click(screen.getByRole("button", { name: "Add integration" }));
    const directory = await screen.findByRole("dialog", { name: "Add integration" });
    expect(within(directory).getByRole("button", { name: /^Team Linear/ })).toBeInTheDocument();
    expect(within(directory).queryByRole("button", { name: /by address/ })).toBeNull();
  });

  it("says when there is nothing to add", () => {
    mountList([], { canAdd: false });
    expect(screen.getByText("No integrations yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add integration" })).toBeNull();
  });
});
