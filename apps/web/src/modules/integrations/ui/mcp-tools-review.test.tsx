import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { McpToolEntry } from "../mcp/catalog.ts";
import type { AdminIntegration } from "../schema.ts";
import { approveIntegrationCatalog } from "../server/functions.ts";
import { McpToolsReview } from "./mcp-tools-review.tsx";

vi.mock("../server/functions.ts", () => ({
  approveIntegrationCatalog: vi.fn(async () => ({
    ok: true,
    catalog: {
      approved: [],
      latest: [],
      server: null,
      checkedAt: null,
      checkError: null,
      reviewedAt: null,
      version: "v2",
    },
  })),
  checkIntegrationCatalog: vi.fn(),
  listAdminIntegrations: vi.fn(),
}));

const tool = (mcpName: string, patch: Partial<McpToolEntry> = {}): McpToolEntry => ({
  key: mcpName,
  mcpName,
  title: mcpName.replace("_", " "),
  description: `${mcpName} description`,
  inputSchema: { type: "object", properties: {} },
  annotations: {},
  access: "destructive",
  enabled: false,
  fingerprint: `${mcpName}-1`,
  ...patch,
});

const row = (approved: McpToolEntry[], latest: McpToolEntry[]): AdminIntegration => ({
  id: "mcp",
  kind: "mcp",
  name: "Docs",
  enabled: true,
  config: { url: "https://mcp.example.com/mcp", auth: "none" },
  oauthClientId: null,
  oauthSecretConfigured: false,
  allowApiKeys: true,
  audience: "instance",
  connectionCount: 0,
  sharedCredentialConfigured: false,
  catalog: {
    approved,
    latest,
    server: { name: "docs", version: "1.0.0", protocol: "2026-07-28" },
    checkedAt: "2026-10-09T10:00:00Z",
    checkError: null,
    reviewedAt: approved.length ? "2026-10-08T10:00:00Z" : null,
    version: "v1",
  },
});

const mount = (integration: AdminIntegration) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <McpToolsReview row={integration} onOpenChange={() => {}} />
    </QueryClientProvider>,
  );

describe("reviewing an MCP server's tools", () => {
  it("marks what changed since approval and keeps earlier choices", () => {
    mount(
      row(
        [
          tool("search", { enabled: true, access: "read", accessChosen: true }),
          tool("old_tool", { enabled: true }),
        ],
        [
          tool("search", { fingerprint: "search-2", description: "now different" }),
          tool("new_tool", { annotations: { readOnlyHint: true }, access: "read" }),
        ],
      ),
    );
    const dialog = screen.getByRole("dialog", { name: "Docs tools" });
    expect(
      within(dialog).getByText("docs · v1.0.0 · protocol 2026-07-28", { exact: false }),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Changed")).toBeInTheDocument();
    expect(within(dialog).getByText("New")).toBeInTheDocument();
    expect(within(dialog).getByText("Removed")).toBeInTheDocument();
    // An approved tool stays on with the admin's own access; a new one starts off.
    expect(within(dialog).getByRole("switch", { name: "Offer search" })).toBeChecked();
    expect(within(dialog).getByRole("switch", { name: "Offer new tool" })).not.toBeChecked();
    expect(within(dialog).getByText("1 of 64 on · 3 to review")).toBeInTheDocument();
  });

  it("approves exactly the listing it showed, with the admin's decisions", async () => {
    const user = userEvent.setup();
    mount(row([], [tool("search", { access: "read" }), tool("drop_table")]));
    await user.click(screen.getByRole("switch", { name: "Offer search" }));
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(approveIntegrationCatalog).toHaveBeenCalledWith({
        data: {
          integrationId: "mcp",
          fingerprint: "v1",
          decisions: [
            { mcpName: "search", enabled: true, access: "read" },
            { mcpName: "drop_table", enabled: false, access: "destructive" },
          ],
        },
      }),
    );
  });

  it("cannot turn on a tool it cannot offer", () => {
    mount(row([], [tool("odd", { unsupported: "It does not take named arguments." })]));
    // Base UI's switch is a span, so it says disabled the accessible way.
    expect(screen.getByRole("switch", { name: "Offer odd" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByText("Can’t offer")).toBeInTheDocument();
  });
});
