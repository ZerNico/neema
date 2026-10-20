import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { unexpectedFailureBody } from "~/server-error.ts";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GroupsPage } from "./groups-page.tsx";
import {
  createGroup,
  getDefaultCapabilities,
  updateDefaultCapabilities,
} from "../server/functions.ts";
import { ALL_CAPABILITIES } from "~/modules/groups/policy.ts";

const navigate = vi.hoisted(() => vi.fn());

// The limits editor has its own tests; this page only places it.
vi.mock("~/modules/limits/ui/limits-editor.tsx", () => ({ LimitsSection: () => null }));
vi.mock("../server/functions.ts", () => ({
  listGroups: vi.fn(),
  listGroupMemberships: vi.fn(),
  createGroup: vi.fn(),
  getDefaultCapabilities: vi.fn(),
  updateDefaultCapabilities: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children, ...rest }: Record<string, unknown> & { children?: unknown }) => (
    <a
      href={String(to)}
      data-group-id={(params as { groupId?: string } | undefined)?.groupId}
      {...(rest as object)}
    >
      {children as never}
    </a>
  ),
  useMatches: () => [{ pathname: "/admin/groups" }],
  useNavigate: () => navigate,
  useParams: () => ({}),
}));

const createMock = vi.mocked(createGroup);

const group = (id: string, name: string, memberCount: number) => ({
  id,
  name,
  memberCount,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const renderPage = (groups: ReturnType<typeof group>[]) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["admin", "groups"], groups);
  client.setQueryData(["admin", "default-capabilities"], ALL_CAPABILITIES);
  return render(
    <QueryClientProvider client={client}>
      <Suspense fallback={null}>
        <GroupsPage />
      </Suspense>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDefaultCapabilities).mockResolvedValue(ALL_CAPABILITIES);
});

describe("GroupsPage", () => {
  it("keeps the fallback policy behind a button and edits it independently of groups", async () => {
    renderPage([]);
    expect(screen.queryByRole("group", { name: "Skills" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Default access" }));
    const skills = await screen.findByRole("group", { name: "Skills" });
    fireEvent.click(within(skills).getByRole("button", { name: "Use" }));
    await waitFor(() =>
      expect(updateDefaultCapabilities).toHaveBeenCalledWith({
        data: { capabilities: { ...ALL_CAPABILITIES, skillsCreate: false } },
      }),
    );
  });

  it("shows a change at once and keeps the controls usable while it saves", async () => {
    let finishFirst!: () => void;
    vi.mocked(updateDefaultCapabilities)
      .mockImplementationOnce(() => new Promise<void>((resolve) => (finishFirst = resolve)))
      .mockResolvedValue(undefined);
    renderPage([]);
    fireEvent.click(screen.getByRole("button", { name: "Default access" }));
    const skills = await screen.findByRole("group", { name: "Skills" });
    const agents = screen.getByRole("group", { name: "Agents" });
    fireEvent.click(within(skills).getByRole("button", { name: "Use" }));
    // The first save is still held open here, so this is the local choice.
    await waitFor(() =>
      expect(within(skills).getByRole("button", { name: "Use" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    const off = within(agents).getByRole("button", { name: "Off" });
    expect(off).toBeEnabled();
    fireEvent.click(off);
    // The second save waits for the first and carries both changes.
    expect(updateDefaultCapabilities).toHaveBeenCalledTimes(1);
    finishFirst();
    await waitFor(() =>
      expect(updateDefaultCapabilities).toHaveBeenLastCalledWith({
        data: {
          capabilities: {
            ...ALL_CAPABILITIES,
            skillsCreate: false,
            agentsUse: false,
            agentsCreate: false,
          },
        },
      }),
    );
  });

  it("lists groups with their member counts, each linking to its detail", async () => {
    renderPage([group("g1", "Engineering", 3), group("g2", "Design", 1)]);

    const row = (await screen.findByText("Engineering")).closest("a")!;
    expect(row).toHaveAttribute("data-group-id", "g1");
    expect(row.textContent).toContain("3 members");
    expect(screen.getByText("Design").closest("a")!.textContent).toContain("1 member");
  });

  it("offers creation from the empty state", async () => {
    renderPage([]);
    expect(await screen.findByText("No groups yet")).toBeInTheDocument();
  });

  it("creates a group from the dialog", async () => {
    createMock.mockResolvedValue(group("g9", "Ops", 0) as never);
    renderPage([group("g1", "Engineering", 3)]);

    fireEvent.click(await screen.findByRole("button", { name: "New group" }));
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Ops" } });
    fireEvent.submit(screen.getByLabelText("Name").closest("form")!);

    await waitFor(() => expect(createMock).toHaveBeenCalledWith({ data: { name: "Ops" } }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/admin/groups/$groupId",
        params: { groupId: "g9" },
      }),
    );
  });

  it("does not navigate when group creation is refused", async () => {
    createMock.mockRejectedValue(new Error(unexpectedFailureBody("ABC234")));
    renderPage([group("g1", "Existing", 0)]);
    fireEvent.click(await screen.findByRole("button", { name: "New group" }));
    const field = await screen.findByLabelText("Name");
    fireEvent.change(field, { target: { value: "A".repeat(101) } });
    fireEvent.submit(field.closest("form")!);
    expect(createMock).not.toHaveBeenCalled();
    expect(screen.getByText("Keep it to 100 characters.")).toBeVisible();

    fireEvent.change(field, { target: { value: "Engineering" } });
    fireEvent.submit(field.closest("form")!);
    expect(await screen.findByText("Could not create the group.")).toBeVisible();
    expect(screen.getByRole("dialog", { name: "New group" })).toBeVisible();
    expect(navigate).not.toHaveBeenCalled();
  });
});
