import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { adminIntegrationsQuery } from "../client/queries.ts";
import type { AdminIntegration } from "../schema.ts";
import { createIntegration } from "../server/functions.ts";
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
  listAdminIntegrations: vi.fn(),
  listIntegrationDirectory: vi.fn(async () => []),
}));

const adminRow = (
  id: string,
  name: string,
  patch: Partial<AdminIntegration> = {},
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

const mount = (integrations: ReturnType<typeof adminRow>[]) => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
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

  it("adds a type under a free name, then opens its settings", async () => {
    const user = userEvent.setup();
    mount([adminRow("jira", "Jira")]);
    await user.click(screen.getByRole("button", { name: "Add integration" }));
    const directory = await screen.findByRole("dialog", { name: "Add integration" });
    await user.click(within(directory).getByRole("button", { name: /^Jira/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add Jira" });
    // The type's name is taken, so the next one is numbered.
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Jira 2");
    await user.clear(within(dialog).getByLabelText("Name"));
    await user.type(within(dialog).getByLabelText("Name"), "Jira · Ops");
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/admin/integrations/$integrationId",
        params: { integrationId: "jira-2" },
        search: { setup: true },
      }),
    );
    expect(createIntegration).toHaveBeenCalledWith({ data: { kind: "jira", name: "Jira · Ops" } });
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
      search: {},
    });
  });

  it("opens a known server that lets in only registered apps on its settings, for the app", async () => {
    const user = userEvent.setup();
    vi.mocked(createIntegration).mockResolvedValueOnce({ ok: true, id: "asana" } as never);
    mount([]);
    await user.click(screen.getByRole("button", { name: "Add integration" }));
    const directory = await screen.findByRole("dialog", { name: "Add integration" });
    await user.type(within(directory).getByRole("searchbox", { name: "Search services" }), "asana");
    await user.click(within(directory).getByRole("button", { name: /^Asana/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add Asana" });
    expect(dialog).toHaveTextContent(/client ID and secret of an app registered with Asana next/);
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(navigate).toHaveBeenLastCalledWith({
        to: "/admin/integrations/$integrationId",
        params: { integrationId: "asana" },
        search: { setup: true },
      }),
    );
  });
});
