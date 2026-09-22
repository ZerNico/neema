import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { GroupDetailPage } from "./group-detail-page.tsx";
import { listGroupMembers, updateGroupMemberSharing } from "../server/functions.ts";

vi.mock("../server/functions.ts", () => ({
  listGroups: vi.fn(),
  listGroupMemberships: vi.fn(),
  listGroupMembers: vi.fn(),
  addGroupMember: vi.fn(),
  removeGroupMember: vi.fn(),
  deleteGroup: vi.fn(),
  renameGroup: vi.fn(),
  updateGroupMemberSharing: vi.fn(),
}));
vi.mock("./users-page.tsx", () => ({
  usersQuery: { queryKey: ["admin", "users"], queryFn: async () => [] },
}));
vi.mock("~/ui/confirm.tsx", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useMatches: () => [{ pathname: "/admin/groups/g1" }],
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));

const members = [
  { userId: "u1", name: "Alice", email: "alice@example.test", role: "user", canShare: false },
  { userId: "u2", name: "Bob", email: "bob@example.test", role: "user", canShare: true },
  { userId: "a1", name: "Admin", email: "admin@example.test", role: "admin", canShare: false },
];
const renderPage = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["admin", "groups"], [{ id: "g1", name: "Engineering", memberCount: 3 }]);
  client.setQueryData(["admin", "group-members", "g1"], members);
  client.setQueryData(["admin", "users"], []);
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <Suspense fallback={null}>
        <GroupDetailPage groupId="g1" />
      </Suspense>
    </QueryClientProvider>,
  );
  return { client, invalidate };
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listGroupMembers).mockResolvedValue(members);
});

// jsdom applies no stylesheet, so the sr-only span that names each switch stays
// inline and its accessible name loses the word space a browser derives from
// blockifying an absolutely positioned element. Match either spelling.
const shareSwitch = (member: string) =>
  screen.getByRole("switch", { name: new RegExp(`^Can share into this group\\s?for ${member}$`) });

describe("GroupDetailPage sharing permissions", () => {
  it("renders saved per-member permissions and an admin override without a switch", () => {
    renderPage();
    expect(shareSwitch("Alice")).not.toBeChecked();
    expect(shareSwitch("Bob")).toBeChecked();
    expect(screen.getAllByRole("switch")).toHaveLength(2);
    expect(screen.getByText("Always allowed, admin")).toBeInTheDocument();
    expect(screen.getByText(/Disabling it leaves existing shares intact/)).toBeInTheDocument();
  });

  it("scopes updates to the member and group, disables conflicts and invalidates on success", async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    vi.mocked(updateGroupMemberSharing).mockReturnValue(pending);
    const { invalidate } = renderPage();
    fireEvent.click(shareSwitch("Alice"));
    await waitFor(() =>
      expect(updateGroupMemberSharing).toHaveBeenCalledWith({
        data: { groupId: "g1", userId: "u1", canShare: true },
      }),
    );
    expect(shareSwitch("Alice")).not.toBeChecked();
    expect(shareSwitch("Alice")).toHaveAttribute("aria-busy", "true");
    for (const control of screen.getAllByRole("switch"))
      expect(control).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Remove Alice" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Group actions" })).toBeDisabled();
    vi.mocked(listGroupMembers).mockResolvedValue(
      members.map((m) => (m.userId === "u1" ? Object.assign({}, m, { canShare: true }) : m)),
    );
    await act(async () => resolve());
    await waitFor(() => expect(shareSwitch("Alice")).toBeChecked());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["admin"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["chat-models"] });
  });

  it("preserves the saved value and reports failed updates", async () => {
    vi.mocked(updateGroupMemberSharing).mockRejectedValue(new Error("failed"));
    const { invalidate } = renderPage();
    fireEvent.click(shareSwitch("Bob"));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Could not update sharing permission.", {
        description: "Failed.",
      }),
    );
    expect(updateGroupMemberSharing).toHaveBeenCalledWith({
      data: { groupId: "g1", userId: "u2", canShare: false },
    });
    expect(shareSwitch("Bob")).toBeChecked();
    expect(shareSwitch("Bob")).not.toHaveAttribute("aria-disabled", "true");
    expect(invalidate).not.toHaveBeenCalled();
  });
});
