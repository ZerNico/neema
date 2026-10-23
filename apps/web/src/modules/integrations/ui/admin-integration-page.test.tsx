import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { adminIntegrationsQuery } from "../client/queries.ts";
import type { AdminIntegration, AdminTool } from "../schema.ts";
import { saveIntegrationConfig, setIntegrationTool } from "../server/functions.ts";
import { AdminIntegrationPage } from "./admin-integration-page.tsx";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children?: unknown }) => (
    <a href={to}>{children as never}</a>
  ),
  useMatches: () => [],
  useNavigate: () => vi.fn(),
  useRouterState: () => "/admin/integrations/mcp",
}));
vi.mock("../server/functions.ts", () => ({
  checkIntegrationTools: vi.fn(async () => ({ ok: true })),
  deleteIntegration: vi.fn(),
  saveIntegrationConfig: vi.fn(async () => ({ ok: true })),
  setIntegrationTool: vi.fn(async () => ({ ok: true })),
  listAdminIntegrations: vi.fn(),
  listIntegrationDirectory: vi.fn(async () => []),
}));
vi.mock("~/modules/sharing/ui/access-dialog.tsx", () => ({ AccessDialog: () => null }));

const tool = (name: string, patch: Partial<AdminTool> = {}): AdminTool => ({
  name,
  title: name.replace("_", " "),
  description: `${name} things`,
  access: "destructive",
  claimed: "destructive",
  off: false,
  unsupported: null,
  pastLimit: false,
  ...patch,
});

const server = (
  patch: Partial<AdminIntegration> = {},
): AdminIntegration & { redirectUri: string | null } => ({
  id: "mcp",
  kind: "mcp",
  name: "DeepWiki",
  description: null,
  server: null,
  enabled: true,
  config: { url: "https://mcp.deepwiki.com/mcp", ways: "anonymous", anonymous: "open" },
  oauthClientId: null,
  oauthSecretConfigured: false,
  allowApiKeys: false,
  audience: "instance",
  connectionCount: 0,
  sharedCredentialConfigured: false,
  tools: [],
  listings: { checkedAt: null, failing: 0, error: null },
  redirectUri: null,
  ...patch,
});

const mount = (row: ReturnType<typeof server>) => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(adminIntegrationsQuery.queryKey, {
    integrations: [row],
    origin: "https://chat.example",
  });
  render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <AdminIntegrationPage integrationId={row.id} />
      </ConfirmProvider>
    </QueryClientProvider>,
  );
};

describe("an integration's admin page", () => {
  it("turns a tool off for everyone and corrects what one does", async () => {
    const user = userEvent.setup();
    mount(
      server({
        tools: [tool("ask_question", { access: "read", claimed: "read" }), tool("drop_index")],
      }),
    );
    await user.click(screen.getByRole("switch", { name: "Offer drop index" }));
    await waitFor(() =>
      expect(setIntegrationTool).toHaveBeenCalledWith({
        data: { integrationId: "mcp", tool: "drop_index", off: true, access: null },
      }),
    );
    // A server that claims too much is corrected; back to its claim is no correction.
    await user.click(screen.getByRole("combobox", { name: "What drop index does" }));
    await user.click(await screen.findByRole("option", { name: "Reads only" }));
    await waitFor(() =>
      expect(setIntegrationTool).toHaveBeenLastCalledWith({
        data: { integrationId: "mcp", tool: "drop_index", off: false, access: "read" },
      }),
    );
  });

  it("says when tools wait for someone to connect", () => {
    mount(
      server({ config: { url: "https://mcp.linear.app/mcp", ways: "oauth" }, server: "linear" }),
    );
    expect(screen.getByText(/They show once someone connects/)).toBeInTheDocument();
  });

  it("shows what a known server needs from its service's own admin", () => {
    mount(
      server({
        name: "Atlassian",
        server: "atlassian",
        config: { url: "https://mcp.atlassian.com/v1/mcp", ways: "oauth" },
      }),
    );
    expect(screen.getByText(/allow https:\/\/chat\.example\/\*\*/)).toBeInTheDocument();
  });

  it("edits its description and keeps it on as it was", async () => {
    const user = userEvent.setup();
    mount(server());
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit DeepWiki" });
    // Empty, it reads as the type's own words.
    expect(within(dialog).getByLabelText(/Description/)).toHaveAttribute(
      "placeholder",
      "Tools from a remote Model Context Protocol server.",
    );
    await user.type(within(dialog).getByLabelText(/Description/), "Docs for any repo");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(saveIntegrationConfig).toHaveBeenCalledWith({
        data: expect.objectContaining({ description: "Docs for any repo", enabled: true }),
      }),
    );
  });

  it("turns it off from its page, keeping everything else as stored", async () => {
    const user = userEvent.setup();
    mount(server());
    await user.click(screen.getByRole("switch", { name: "DeepWiki on" }));
    await waitFor(() =>
      expect(saveIntegrationConfig).toHaveBeenLastCalledWith({
        data: {
          integrationId: "mcp",
          name: "DeepWiki",
          description: "",
          enabled: false,
          config: { url: "https://mcp.deepwiki.com/mcp", ways: "anonymous", anonymous: "open" },
          oauthClientId: "",
          allowApiKeys: false,
        },
      }),
    );
  });

  it("ticks the ways into an MCP server and shows only what they need", async () => {
    const user = userEvent.setup();
    mount(server());
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit DeepWiki" });
    expect(within(dialog).getByRole("radio", { name: "No key" })).toBeChecked();
    expect(within(dialog).queryByLabelText("Redirect URI")).not.toBeInTheDocument();

    // Private repos want a token beside open use.
    expect(within(dialog).queryByLabelText(/Header/)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("checkbox", { name: "Personal token" }));
    expect(within(dialog).getByLabelText(/Header/)).toBeInTheDocument();

    // Signing in registers the app by itself, so its own client waits behind a switch.
    await user.click(within(dialog).getByRole("checkbox", { name: "Sign in" }));
    expect(within(dialog).queryByLabelText("Redirect URI")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("switch", { name: "Registered app" }));
    expect(within(dialog).getByLabelText("Redirect URI")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("checkbox", { name: "Sign in" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(saveIntegrationConfig).toHaveBeenLastCalledWith({
        data: expect.objectContaining({
          config: expect.objectContaining({ ways: "token anonymous", anonymous: "open" }),
        }),
      }),
    );
  });
});
