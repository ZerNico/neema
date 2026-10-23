import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { adminIntegrationsQuery } from "../client/queries.ts";
import type { AdminIntegration } from "../schema.ts";
import {
  createIntegration,
  deleteIntegration,
  listAdminIntegrations,
  saveIntegrationConfig,
} from "../server/functions.ts";
import { AdminIntegrationsPage } from "./admin-integrations-page.tsx";

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children }: { to: string; params?: object; children?: unknown }) => (
    <a href={`${to}${params ? `#${JSON.stringify(params)}` : ""}`}>{children as never}</a>
  ),
  useNavigate: () => navigate,
}));
vi.mock("../server/functions.ts", () => ({
  createIntegration: vi.fn(async () => ({ ok: true, id: "jira-2" })),
  deleteIntegration: vi.fn(async () => ({ ok: true })),
  saveIntegrationConfig: vi.fn(async () => ({ ok: true })),
  listAdminIntegrations: vi.fn(),
  listIntegrationDirectory: vi.fn(async () => []),
}));

const adminRow = (
  id: string,
  name: string,
  patch: Partial<AdminIntegration & { redirectUri: string | null }> = {},
): AdminIntegration & { redirectUri: string | null } => ({
  id,
  kind: "jira",
  name,
  description: null,
  server: null,
  enabled: true,
  config: { site: "https://acme.atlassian.net" },
  oauthClientId: null,
  oauthSecretConfigured: false,
  allowApiKeys: true,
  audience: "instance",
  connectionCount: 2,
  sharedCredentialConfigured: false,
  tools: [],
  listings: null,
  redirectUri: null,
  ...patch,
});

/** `created` is what the list holds once the dialog's create refetches it. */
const mount = (
  integrations: ReturnType<typeof adminRow>[],
  created: ReturnType<typeof adminRow>[] = [],
) => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  vi.mocked(listAdminIntegrations).mockResolvedValue({
    integrations: [...integrations, ...created],
    origin: null,
  } as never);
  client.setQueryData(adminIntegrationsQuery.queryKey, { integrations, origin: null });
  render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <AdminIntegrationsPage />
      </ConfirmProvider>
    </QueryClientProvider>,
  );
};

describe("admin integrations", () => {
  it("lists each integration on its own page, with its type when the name does not say it", () => {
    mount([adminRow("jira", "Jira"), adminRow("jira-ops", "Ops tracker")]);
    expect(screen.getByText("2 people connected", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Jira · 2 people connected")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Ops tracker/ })).toHaveAttribute(
      "href",
      '/admin/integrations/$integrationId#{"integrationId":"jira-ops"}',
    );
  });

  it("sets a type up in the same dialog and turns it on by saving it", async () => {
    const user = userEvent.setup();
    mount([adminRow("jira", "Jira")], [adminRow("jira-2", "Jira 2", { enabled: false })]);
    await user.click(screen.getByRole("button", { name: "Add integration" }));
    const directory = await screen.findByRole("dialog", { name: "Add integration" });
    await user.click(within(directory).getByRole("button", { name: /^Jira/ }));
    // The type's name is taken, so the next one is numbered.
    expect(createIntegration).toHaveBeenCalledWith({ data: { kind: "jira", name: "Jira 2" } });
    const dialog = await screen.findByRole("dialog", { name: "Set up Jira 2" });
    await user.clear(within(dialog).getByLabelText("Name"));
    await user.type(within(dialog).getByLabelText("Name"), "Jira · Ops");
    await user.click(within(dialog).getByRole("button", { name: "Turn on" }));
    await waitFor(() =>
      expect(saveIntegrationConfig).toHaveBeenCalledWith({
        data: expect.objectContaining({
          integrationId: "jira-2",
          name: "Jira · Ops",
          enabled: true,
        }),
      }),
    );
    expect(navigate).toHaveBeenLastCalledWith({
      to: "/admin/integrations/$integrationId",
      params: { integrationId: "jira-2" },
    });
    expect(deleteIntegration).not.toHaveBeenCalled();
  });

  it("asks how people connect, and needs at least one way before it turns on", async () => {
    const user = userEvent.setup();
    mount(
      [adminRow("jira", "Jira")],
      [adminRow("jira-2", "Jira 2", { enabled: false, allowApiKeys: true })],
    );
    await user.click(screen.getByRole("button", { name: "Add integration" }));
    const directory = await screen.findByRole("dialog", { name: "Add integration" });
    await user.click(within(directory).getByRole("button", { name: /^Jira/ }));
    const dialog = await screen.findByRole("dialog", { name: "Set up Jira 2" });
    // Keys come on by default, so the app's fields wait until signing in is picked.
    expect(within(dialog).getByRole("checkbox", { name: "Personal API keys" })).toBeChecked();
    expect(within(dialog).queryByLabelText(/OAuth client ID/)).toBeNull();
    await user.click(within(dialog).getByRole("checkbox", { name: "Sign in" }));
    // Picked, its client is required: no optional mark on either half.
    for (const name of ["OAuth client ID", "OAuth client secret"])
      expect(within(dialog).getByText(name).closest("label")).not.toHaveTextContent("optional");
    await user.click(within(dialog).getByRole("checkbox", { name: "Sign in" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "Personal API keys" }));
    expect(within(dialog).getByText("Pick at least one.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Turn on" })).toBeDisabled();
  });

  it("deletes what was picked when setting it up is abandoned", async () => {
    const user = userEvent.setup();
    mount([adminRow("jira", "Jira")], [adminRow("jira-2", "Jira 2", { enabled: false })]);
    await user.click(screen.getByRole("button", { name: "Add integration" }));
    const directory = await screen.findByRole("dialog", { name: "Add integration" });
    await user.click(within(directory).getByRole("button", { name: /^Jira/ }));
    const dialog = await screen.findByRole("dialog", { name: "Set up Jira 2" });
    await user.click(within(dialog).getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("dialog", { name: "Add integration" })).toBeInTheDocument();
    expect(deleteIntegration).toHaveBeenCalledWith({ data: { integrationId: "jira-2" } });
  });

  it("adds a known server as it is, and offers each one once", async () => {
    const user = userEvent.setup();
    vi.mocked(createIntegration).mockResolvedValueOnce({ ok: true, id: "mcp" } as never);
    mount([adminRow("mcp-2", "Linear", { kind: "mcp", server: "linear" })]);
    await user.click(screen.getByRole("button", { name: "Add integration" }));
    const directory = await screen.findByRole("dialog", { name: "Add integration" });
    expect(within(directory).queryByRole("button", { name: /^Linear/ })).toBeNull();
    await user.type(within(directory).getByRole("searchbox", { name: "Search services" }), "card");
    await user.click(within(directory).getByRole("button", { name: /^Trello/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add Trello" });
    // Nothing to fill in: its address and sign-in come with it.
    expect(within(dialog).queryByLabelText("Name")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(createIntegration).toHaveBeenCalledWith({
        data: { kind: "mcp", name: "Trello", server: "trello" },
      }),
    );
    expect(navigate).toHaveBeenLastCalledWith({
      to: "/admin/integrations/$integrationId",
      params: { integrationId: "mcp" },
    });
  });

  it("asks a known server that lets in only registered apps for the app before it is on", async () => {
    const user = userEvent.setup();
    vi.mocked(createIntegration).mockResolvedValueOnce({ ok: true, id: "asana" } as never);
    mount(
      [],
      [
        adminRow("asana", "Asana", {
          kind: "mcp",
          server: "asana",
          enabled: false,
          config: { url: "https://mcp.asana.com/sse", ways: "oauth" },
          redirectUri: "https://chat.example/api/integrations/asana/callback",
        }),
      ],
    );
    await user.click(screen.getByRole("button", { name: "Add integration" }));
    const directory = await screen.findByRole("dialog", { name: "Add integration" });
    await user.type(within(directory).getByRole("searchbox", { name: "Search services" }), "asana");
    await user.click(within(directory).getByRole("button", { name: /^Asana/ }));
    const dialog = await screen.findByRole("dialog", { name: "Set up Asana" });
    expect(within(dialog).getByLabelText("Redirect URI")).toHaveValue(
      "https://chat.example/api/integrations/asana/callback",
    );
    expect(within(dialog).getByRole("button", { name: "Turn on" })).toBeInTheDocument();
  });
});
