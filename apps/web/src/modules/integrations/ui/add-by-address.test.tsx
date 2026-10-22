import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { IntegrationConnectionView, UserIntegration } from "../schema.ts";
import {
  deletePersonalServer,
  finishServerSetup,
  getServerSetup,
  probeServer,
  savePersonalServer,
} from "../server/functions.ts";
import { AddByAddress } from "./add-by-address.tsx";

vi.mock("../server/functions.ts", () => ({
  probeServer: vi.fn(),
  savePersonalServer: vi.fn(async () => ({ ok: true, server: { id: "mcp-9" } })),
  getServerSetup: vi.fn(),
  finishServerSetup: vi.fn(async () => ({ ok: true })),
  deletePersonalServer: vi.fn(async () => ({ ok: true })),
  listMyIntegrations: vi.fn(async () => []),
  listPersonalServers: vi.fn(async () => ({ canAdd: true, servers: [] })),
}));

const docs = (connections: IntegrationConnectionView[]): UserIntegration => ({
  id: "mcp-9",
  kind: "mcp",
  name: "example.com",
  description: null,
  server: null,
  available: true,
  personal: true,
  methods: { oauth: true, apiKey: false, open: null, everyone: false },
  tools: [],
  apiKeyHelpUrl: null,
  connections,
});

const account: IntegrationConnectionView = {
  id: "connection-9",
  authKind: "none",
  accountLabel: "example.com",
  name: null,
  status: "active",
  offerByDefault: true,
  toolPermissions: {},
  scope: null,
  requiredScopes: null,
  listing: null,
  tools: [{ name: "ask", title: "Ask", label: "Asking", description: "", access: "read" }],
  dependents: { sources: 0, schedules: 0 },
  createdAt: "2026-10-20T10:00:00Z",
};

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AddByAddress onBack={() => {}} onDone={() => {}} onOpenPage={() => {}} />
    </QueryClientProvider>,
  );

describe("adding a server by its address", () => {
  it("asks the server how it connects, and an open one is ready at once", async () => {
    const user = userEvent.setup();
    vi.mocked(probeServer).mockResolvedValueOnce({
      ok: true,
      ways: "anonymous",
      name: "example.com",
    } as never);
    vi.mocked(getServerSetup).mockResolvedValue({
      ok: true,
      integration: docs([account]),
    } as never);
    mount();
    await user.type(screen.getByLabelText("Server address"), "https://mcp.example.com/mcp");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("example.com is ready")).toBeInTheDocument();
    expect(savePersonalServer).toHaveBeenCalledWith({
      data: {
        integrationId: null,
        name: "example.com",
        config: { url: "https://mcp.example.com/mcp", ways: "anonymous" },
      },
    });
    await waitFor(() =>
      expect(finishServerSetup).toHaveBeenCalledWith({ data: { integrationId: "mcp-9" } }),
    );
  });

  it("goes on to sign in for one that needs it, and going back leaves nothing behind", async () => {
    const user = userEvent.setup();
    vi.mocked(probeServer).mockResolvedValueOnce({
      ok: true,
      ways: "oauth",
      name: "example.com",
    } as never);
    vi.mocked(getServerSetup).mockResolvedValue({ ok: true, integration: docs([]) } as never);
    mount();
    await user.type(screen.getByLabelText("Server address"), "https://mcp.example.com/mcp");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() =>
      expect(deletePersonalServer).toHaveBeenCalledWith({ data: { integrationId: "mcp-9" } }),
    );
    expect(screen.getByLabelText("Server address")).toBeInTheDocument();
  });

  it("asks for an app of one's own where the server registers none, before signing in", async () => {
    const user = userEvent.setup();
    vi.mocked(probeServer).mockResolvedValueOnce({
      ok: true,
      ways: "oauth",
      name: "asana.com",
      needsClient: true,
    } as never);
    const server = {
      id: "mcp-9",
      name: "asana.com",
      config: { url: "https://mcp.asana.com/v2/mcp", ways: "oauth" },
      oauthClientId: null,
      oauthSecretConfigured: false,
      redirectUri: "https://chat.example.com/api/integrations/mcp-9/callback",
      listing: null,
    };
    vi.mocked(savePersonalServer).mockResolvedValue({ ok: true, server } as never);
    vi.mocked(getServerSetup).mockResolvedValue({ ok: true, integration: docs([]) } as never);
    mount();
    await user.type(screen.getByLabelText("Server address"), "https://mcp.asana.com/v2/mcp");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    // Its redirect URI, to register the app with, and no sign-in until the app is in.
    expect(await screen.findByLabelText("Redirect URI")).toHaveValue(server.redirectUri);
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    await user.type(screen.getByLabelText(/OAuth client ID/), "app-1");
    await user.type(screen.getByLabelText(/OAuth client secret/), "secret-1");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(savePersonalServer).toHaveBeenLastCalledWith({
      data: {
        integrationId: "mcp-9",
        name: "asana.com",
        config: server.config,
        oauthClientId: "app-1",
        oauthClientSecret: "secret-1",
      },
    });
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("says why an address will not do, and saves nothing", async () => {
    const user = userEvent.setup();
    vi.mocked(savePersonalServer).mockClear();
    vi.mocked(probeServer).mockResolvedValueOnce({
      ok: false,
      error: "Use a public address. An admin can add servers on a private network.",
    } as never);
    mount();
    await user.type(screen.getByLabelText("Server address"), "https://10.0.0.5/mcp");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText(/Use a public address/)).toBeInTheDocument();
    expect(savePersonalServer).not.toHaveBeenCalled();
  });
});
