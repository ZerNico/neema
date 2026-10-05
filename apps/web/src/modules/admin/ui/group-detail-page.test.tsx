import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { GroupDetailPage } from "./group-detail-page.tsx";
import {
  getGroupCapabilities,
  listGroupMembers,
  updateGroupCapabilities,
  updateGroupMemberSharing,
} from "../server/functions.ts";
import { ALL_CAPABILITIES } from "~/modules/groups/policy.ts";

vi.mock("../server/functions.ts", () => ({
  listGroups: vi.fn(),
  listGroupMemberships: vi.fn(),
  listGroupMembers: vi.fn(),
  addGroupMember: vi.fn(),
  removeGroupMember: vi.fn(),
  deleteGroup: vi.fn(),
  renameGroup: vi.fn(),
  updateGroupMemberSharing: vi.fn(),
  getGroupCapabilities: vi.fn(),
  updateGroupCapabilities: vi.fn(),
}));
vi.mock("../client/queries.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../client/queries.ts")>()),
  usersQuery: { queryKey: ["admin", "users"], queryFn: async () => [] },
}));
vi.mock("~/ui/confirm-context.ts", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useMatches: () => [{ pathname: "/admin/groups/g1" }],
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));

const none = { agents: false, knowledge: false, skills: false, projects: false };
const members = [
  { userId: "u1", name: "Alice", email: "alice@example.test", role: "user", sharing: none },
  {
    userId: "u2",
    name: "Bob",
    email: "bob@example.test",
    role: "user",
    sharing: { agents: true, knowledge: false, skills: true, projects: false },
  },
  { userId: "a1", name: "Ada", email: "ada@example.test", role: "admin", sharing: none },
];
const renderPage = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["admin", "groups"], [{ id: "g1", name: "Engineering", memberCount: 3 }]);
  client.setQueryData(["admin", "group-members", "g1"], members);
  client.setQueryData(["admin", "group-capabilities", "g1"], ALL_CAPABILITIES);
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
  vi.mocked(getGroupCapabilities).mockResolvedValue(ALL_CAPABILITIES);
  vi.mocked(updateGroupCapabilities).mockResolvedValue(undefined);
});

const openSharing = (member: string) =>
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^Sharing for ${member}:`) }));

describe("GroupDetailPage feature access", () => {
  it("turning agents off clears both use and create, without changing the defaults", async () => {
    renderPage();
    const agents = screen.getByRole("group", { name: "Agents" });
    fireEvent.click(within(agents).getByRole("button", { name: "Off" }));
    await waitFor(() =>
      expect(updateGroupCapabilities).toHaveBeenCalledWith({
        data: {
          groupId: "g1",
          capabilities: { ...ALL_CAPABILITIES, agentsUse: false, agentsCreate: false },
        },
      }),
    );
  });

  it("shows deep research as unavailable while web search is off", async () => {
    vi.mocked(getGroupCapabilities).mockResolvedValue({ ...ALL_CAPABILITIES, webSearch: false });
    const { client } = renderPage();
    client.setQueryData(["admin", "group-capabilities", "g1"], {
      ...ALL_CAPABILITIES,
      webSearch: false,
    });
    const research = await screen.findByRole("switch", { name: "Deep research" });
    await waitFor(() => expect(research).not.toBeChecked());
    expect(research).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Needs web search.")).toBeInTheDocument();
  });
});

describe("GroupDetailPage sharing permissions", () => {
  it("summarises each member’s sharing, with admins always allowed", () => {
    renderPage();
    expect(screen.getByRole("button", { name: "Sharing for Alice: None" })).toHaveTextContent(
      "Sharing: None",
    );
    expect(screen.getByRole("button", { name: "Sharing for Bob: Agents, Skills" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Sharing for Ada/ })).not.toBeInTheDocument();
    expect(screen.getByText("Admin")).toBeInTheDocument();
  });

  it("saves the kinds chosen for one member and refreshes the list", async () => {
    vi.mocked(updateGroupMemberSharing).mockResolvedValue(undefined);
    const { invalidate } = renderPage();
    openSharing("Alice");
    const dialog = await screen.findByRole("dialog", { name: "Sharing for Alice" });
    fireEvent.click(within(dialog).getByRole("switch", { name: "Knowledge" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updateGroupMemberSharing).toHaveBeenCalledWith({
        data: {
          groupId: "g1",
          userId: "u1",
          sharing: { agents: false, knowledge: true, skills: false, projects: false },
        },
      }),
    );
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["admin"] }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps the dialog open with the choice and reports a failed save", async () => {
    vi.mocked(updateGroupMemberSharing).mockRejectedValue(new Error("failed"));
    const { invalidate } = renderPage();
    openSharing("Bob");
    const dialog = await screen.findByRole("dialog", { name: "Sharing for Bob" });
    expect(within(dialog).getByRole("switch", { name: "Agents" })).toBeChecked();
    fireEvent.click(within(dialog).getByRole("switch", { name: "Agents" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Could not update sharing permission.", {
        description: "Failed.",
      }),
    );
    expect(within(dialog).getByRole("switch", { name: "Agents" })).not.toBeChecked();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
