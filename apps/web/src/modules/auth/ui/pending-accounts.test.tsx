import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { decideAccount } from "../server/signup-functions.ts";
import { PendingAccounts } from "./pending-accounts.tsx";

vi.mock("../server/signup-functions.ts", () => ({
  listPendingAccounts: vi.fn(),
  decideAccount: vi.fn(),
}));

const decide = vi.mocked(decideAccount);

const account = (name: string, emailVerified = true) => ({
  userId: `${name}-id`,
  name,
  email: `${name}@example.test`,
  emailVerified,
  requestedAt: new Date("2026-09-01T00:00:00Z"),
});

const renderQueue = (pending: ReturnType<typeof account>[]) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["admin", "pending-accounts"], pending);
  return render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <Suspense fallback={null}>
          <PendingAccounts />
        </Suspense>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  decide.mockResolvedValue(undefined as never);
});

describe("PendingAccounts", () => {
  it("stays out of the way when nobody is waiting", () => {
    const { container } = renderQueue([]);
    expect(container).toBeEmptyDOMElement();
  });

  it("approves the account whose row was pressed", async () => {
    renderQueue([account("ada"), account("grace")]);

    fireEvent.click(await screen.findByRole("button", { name: "Approve grace" }));

    await waitFor(() => expect(decide).toHaveBeenCalled());
    expect(decide.mock.calls[0]?.[0].data).toEqual({ userId: "grace-id", status: "approved" });
  });

  it("asks before declining, says the account is kept, and only then declines it", async () => {
    renderQueue([account("ada")]);

    fireEvent.click(await screen.findByRole("button", { name: "Decline ada" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/cannot sign up again/);
    expect(decide).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Decline" }));

    await waitFor(() => expect(decide).toHaveBeenCalled());
    expect(decide.mock.calls[0]?.[0].data).toEqual({ userId: "ada-id", status: "rejected" });
  });

  it("marks an address nobody has proven, so approving it is a choice", async () => {
    renderQueue([account("ada"), account("typed", false)]);

    const [badge, ...others] = await screen.findAllByText("Unverified");
    expect(others).toHaveLength(0);
    expect(badge?.parentElement).toHaveTextContent("typed@example.test");
  });
});
