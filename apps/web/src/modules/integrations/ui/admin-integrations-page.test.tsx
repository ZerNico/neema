import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { adminIntegrationsQuery } from "../client/queries.ts";
import type { AdminIntegration } from "../schema.ts";
import { createIntegration } from "../server/functions.ts";
import { AdminIntegrationsPage } from "./admin-integrations-page.tsx";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children?: unknown }) => (
    <a href={to}>{children as never}</a>
  ),
  useMatches: () => [],
  useRouterState: () => "/admin/integrations",
}));
vi.mock("../server/functions.ts", () => ({
  createIntegration: vi.fn(async () => ({ ok: true, id: "jira-2" })),
  deleteIntegration: vi.fn(),
  saveIntegrationConfig: vi.fn(),
  listAdminIntegrations: vi.fn(),
  listIntegrationDirectory: vi.fn(async () => []),
}));
vi.mock("~/modules/sharing/ui/access-dialog.tsx", () => ({ AccessDialog: () => null }));

const jira = (id: string, name: string): AdminIntegration & { redirectUri: string | null } => ({
  id,
  kind: "jira",
  name,
  enabled: true,
  config: { site: "https://acme.atlassian.net" },
  oauthClientId: null,
  oauthSecretConfigured: false,
  allowApiKeys: true,
  audience: "instance",
  connectionCount: 2,
  sharedCredentialConfigured: false,
  catalog: null,
  redirectUri: null,
});

const mount = (integrations: ReturnType<typeof jira>[]) => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(adminIntegrationsQuery.queryKey, { integrations });
  render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <AdminIntegrationsPage />
      </ConfirmProvider>
    </QueryClientProvider>,
  );
};

describe("admin integrations", () => {
  it("names each integration, with its type when the name does not say it", () => {
    mount([jira("jira", "Jira"), jira("jira-ops", "Ops tracker")]);
    expect(screen.getByText("2 people connected", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Jira · 2 people connected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set up Ops tracker" })).toBeInTheDocument();
  });

  it("adds a second integration of a type under a free name", async () => {
    const user = userEvent.setup();
    mount([jira("jira", "Jira")]);
    await user.click(screen.getByRole("button", { name: "Add integration" }));
    const dialog = await screen.findByRole("dialog", { name: "Add integration" });
    await user.click(within(dialog).getByRole("radio", { name: "Jira" }));
    // The type's name is taken, so the next one is numbered.
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Jira 2");
    await user.clear(within(dialog).getByLabelText("Name"));
    await user.type(within(dialog).getByLabelText("Name"), "Jira · Ops");
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(createIntegration).toHaveBeenCalledWith({
        data: { kind: "jira", name: "Jira · Ops" },
      }),
    );
  });
});
