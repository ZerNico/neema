import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiKeySummary } from "~/modules/api-keys/schema.ts";
import { createApiKey, revokeApiKey } from "~/modules/api-keys/server/functions.ts";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { ApiKeysPage } from "./api-keys-page.tsx";

vi.mock("~/modules/api-keys/server/functions.ts", () => ({
  listApiKeys: vi.fn(),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children?: unknown }) => (
    <a href={to}>{children as never}</a>
  ),
}));

const createMock = vi.mocked(createApiKey);
const revokeMock = vi.mocked(revokeApiKey);

const key = (overrides: Partial<ApiKeySummary> = {}): ApiKeySummary => ({
  id: "k1",
  name: "n8n",
  start: "nma_abcdef",
  scopes: ["chats:read"],
  expiresAt: new Date("2099-01-01T00:00:00Z"),
  lastUsedAt: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  ...overrides,
});

const renderPage = (keys: ApiKeySummary[] = [], allowed = true) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(["api-keys"], {
    keys,
    allowed,
    serverUrl: "https://chat.example/api/mcp",
  });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <Suspense fallback={null}>
          <ApiKeysPage />
        </Suspense>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
  return { invalidate };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ApiKeysPage", () => {
  it("lists a key by name, start, access and use", () => {
    renderPage([key()]);
    expect(screen.getByText("n8n")).toBeInTheDocument();
    expect(screen.getByText(/nma_abcdef…/)).toBeInTheDocument();
    expect(screen.getByText(/Can see chats · Expires .* · Never used/)).toBeInTheDocument();
  });

  it("makes a key with what was ticked and shows its secret once", async () => {
    const user = userEvent.setup();
    createMock.mockResolvedValue({ key: key(), secret: "nma_secret-value" } as never);
    const { invalidate } = renderPage();
    await user.click(screen.getByRole("button", { name: "New key" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "n8n");
    await user.click(within(dialog).getByRole("checkbox", { name: "Read your memories" }));
    await user.click(
      within(dialog).getByRole("checkbox", {
        name: "Send messages and start chats with your agents",
      }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Make key" }));
    await waitFor(() => expect(createMock).toHaveBeenCalled());
    const sent = createMock.mock.calls[0]![0]!;
    expect(sent.data.name).toBe("n8n");
    expect(sent.data.lifetimeDays).toBe(90);
    expect(sent.data.scopes).toContain("chats:write");
    expect(sent.data.scopes).not.toContain("memory:read");
    expect(sent.data.scopes).not.toContain("documents:write");
    expect(await within(dialog).findByText("nma_secret-value")).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalled();
  });

  it("revokes a key after asking", async () => {
    const user = userEvent.setup();
    revokeMock.mockResolvedValue({ ok: true } as never);
    renderPage([key()]);
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    const confirmDialog = await screen.findByRole("alertdialog");
    await user.click(within(confirmDialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(revokeMock).toHaveBeenCalledWith({ data: { id: "k1" } }));
  });

  it("offers no new key to an account that may not make one", () => {
    renderPage([], false);
    expect(screen.queryByRole("button", { name: "New key" })).not.toBeInTheDocument();
    expect(screen.getByText(/can’t make API keys/)).toBeInTheDocument();
  });
});
