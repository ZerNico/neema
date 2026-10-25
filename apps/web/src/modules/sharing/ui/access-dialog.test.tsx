import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccessDialog } from "./access-dialog.tsx";
import type { ResourceGrants } from "../schema.ts";
import { getResourceSharing, searchShareRecipients, changeSharing } from "../server/functions.ts";
import { toast } from "sonner";
import { ConfirmProvider } from "~/ui/confirm.tsx";

vi.mock("../server/functions.ts", () => ({
  getResourceSharing: vi.fn(),
  searchShareRecipients: vi.fn(),
  changeSharing: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.stubGlobal(
  "matchMedia",
  vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
);

const base: ResourceGrants = {
  audience: "private",
  canPublish: false,
  users: [],
  groups: [],
  eligibleGroups: [],
};

const DANA = { userId: "u1", name: "Dana Lee", email: "dana@example.com" };

const setup = (
  overrides: Partial<ResourceGrants> = {},
  directory: Array<{ userId: string; name: string; email: string }> = [],
) => {
  const data = { ...base, ...overrides };
  vi.mocked(searchShareRecipients).mockResolvedValue(directory);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["sharing", "agent", "a1"], data);
  vi.mocked(getResourceSharing).mockResolvedValue(data);
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <AccessDialog
          resource={{ kind: "agent", id: "a1" }}
          title="Reviewer"
          open
          onOpenChange={onOpenChange}
        />
      </ConfirmProvider>
    </QueryClientProvider>,
  );
  return { onOpenChange };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AccessDialog", () => {
  it("shows one panel: the owner, how to add someone, and no link sharing", () => {
    setup();
    expect(screen.getByRole("dialog", { name: "Access" })).toBeInTheDocument();
    expect(screen.getByText("Nobody else yet. Only you can use this.")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Add people or groups" })).toBeVisible();
    expect(screen.getByText(/their own access to its model and collections/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Copy link" })).not.toBeInTheDocument();
    // A single permission level: rows say what access means, they do not offer roles.
    expect(screen.queryByRole("button", { name: /^Access for/ })).not.toBeInTheDocument();
  });

  it("picks a person out of the directory and grants by their account email", async () => {
    const user = userEvent.setup();
    vi.mocked(changeSharing).mockResolvedValue(undefined as never);
    setup({}, [DANA]);
    await user.click(screen.getByRole("combobox", { name: "Add people or groups" }));
    await user.click(await screen.findByRole("option", { name: /Dana Lee/ }));
    await waitFor(() =>
      expect(changeSharing).toHaveBeenCalledWith({
        data: { kind: "agent", id: "a1", change: { action: "email", email: "dana@example.com" } },
      }),
    );
  });

  it("searches the directory by what was typed", async () => {
    const user = userEvent.setup();
    setup({}, [DANA]);
    await user.click(screen.getByRole("combobox", { name: "Add people or groups" }));
    await user.type(await screen.findByPlaceholderText("Search by name or email…"), "dana@");
    await waitFor(() =>
      expect(searchShareRecipients).toHaveBeenCalledWith({ data: { q: "dana@" } }),
    );
  });

  it("leaves out people who already have access", async () => {
    const user = userEvent.setup();
    setup({ users: [DANA] }, [DANA]);
    await user.click(screen.getByRole("combobox", { name: "Add people or groups" }));
    expect(await screen.findByText("No people or groups match")).toBeVisible();
  });

  it("reports a refused grant without closing the panel", async () => {
    const user = userEvent.setup();
    vi.mocked(changeSharing).mockRejectedValueOnce(new Error("No account for that email."));
    setup({}, [DANA]);
    await user.click(screen.getByRole("combobox", { name: "Add people or groups" }));
    await user.click(await screen.findByRole("option", { name: /Dana Lee/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No account for that email.");
  });

  it("offers eligible groups beside people and grants the chosen one", async () => {
    const user = userEvent.setup();
    vi.mocked(changeSharing).mockResolvedValue(undefined as never);
    setup({ eligibleGroups: [{ id: "g1", name: "Support" }] }, [DANA]);
    await user.click(screen.getByRole("combobox", { name: "Add people or groups" }));
    expect(await screen.findByRole("option", { name: /Dana Lee/ })).toBeVisible();
    await user.click(screen.getByRole("option", { name: /Support/ }));
    await waitFor(() =>
      expect(changeSharing).toHaveBeenCalledWith({
        data: { kind: "agent", id: "a1", change: { action: "group", groupId: "g1" } },
      }),
    );
  });

  it("leaves out groups that already have access", async () => {
    const user = userEvent.setup();
    setup({
      eligibleGroups: [{ id: "g1", name: "Support" }],
      groups: [{ groupId: "g1", name: "Support" }],
    });
    await user.click(screen.getByRole("combobox", { name: "Add people or groups" }));
    expect(await screen.findByText("No people or groups match")).toBeVisible();
  });

  it("removes a grant and says the other ways in are unaffected", async () => {
    const user = userEvent.setup();
    vi.mocked(changeSharing).mockResolvedValue(undefined as never);
    setup({ users: [DANA], groups: [{ groupId: "g1", name: "Support" }] });
    expect(
      within(screen.getByRole("list", { name: "Access" })).getAllByRole("listitem"),
    ).toHaveLength(2);
    // No permanent caveat above the list; the nuance lands on the removal itself.
    expect(screen.queryByText(/still have access/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove access for Dana Lee" }));
    await waitFor(() =>
      expect(changeSharing).toHaveBeenCalledWith({
        data: { kind: "agent", id: "a1", change: { action: "revokeUser", userId: "u1" } },
      }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Removed Dana Lee. They can still use this through a group.",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Remove access for Support" }));
    await waitFor(() =>
      expect(changeSharing).toHaveBeenCalledWith({
        data: { kind: "agent", id: "a1", change: { action: "revokeGroup", groupId: "g1" } },
      }),
    );
  });

  it("says plainly when a removed person had no other way in", async () => {
    const user = userEvent.setup();
    vi.mocked(changeSharing).mockResolvedValue(undefined as never);
    setup({ users: [DANA] });
    await user.click(screen.getByRole("button", { name: "Remove access for Dana Lee" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Removed Dana Lee."));
  });

  it("confirms before letting everyone signed in use it, and not on the way back", async () => {
    const user = userEvent.setup();
    vi.mocked(changeSharing).mockResolvedValue(undefined as never);
    setup({ canPublish: true });
    await user.click(screen.getByRole("combobox", { name: "General access" }));
    await user.click(await screen.findByRole("option", { name: "Everyone signed in" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/does not become public on the internet/);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(changeSharing).not.toHaveBeenCalled();

    await user.click(screen.getByRole("combobox", { name: "General access" }));
    await user.click(await screen.findByRole("option", { name: "Everyone signed in" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Give access" }),
    );
    await waitFor(() =>
      expect(changeSharing).toHaveBeenCalledWith({
        data: { kind: "agent", id: "a1", change: { action: "publish", audience: "instance" } },
      }),
    );
  });

  it("narrows access without a confirmation and explains what everyone signed in means", async () => {
    const user = userEvent.setup();
    vi.mocked(changeSharing).mockResolvedValue(undefined as never);
    setup({ canPublish: true, audience: "instance" });
    expect(screen.getByText(/not public on the internet/)).toBeVisible();
    await user.click(screen.getByRole("combobox", { name: "General access" }));
    await user.click(await screen.findByRole("option", { name: "Only people and groups you add" }));
    await waitFor(() =>
      expect(changeSharing).toHaveBeenCalledWith({
        data: { kind: "agent", id: "a1", change: { action: "publish", audience: "private" } },
      }),
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("shows an administrator's broad access read-only to an owner who cannot publish", () => {
    setup({ audience: "instance" });
    expect(screen.queryByRole("combobox", { name: "General access" })).not.toBeInTheDocument();
    expect(screen.getByText("Everyone signed in")).toBeVisible();
  });
});
