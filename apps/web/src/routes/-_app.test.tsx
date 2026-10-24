import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route, SessionAppSidebar } from "./_app.tsx";
import { meQuery, type Me, type SessionData } from "~/modules/auth/client.ts";
import { getMe } from "~/modules/auth/server/functions.ts";

vi.mock("~/modules/auth/server/functions.ts", () => ({ getMe: vi.fn() }));
vi.mock("~/modules/auth/server/signup-functions.ts", () => ({ getNeedsSetup: vi.fn() }));
vi.mock("~/modules/chat/server/functions.ts", () => ({ listConversations: vi.fn() }));
vi.mock("~/modules/chat/ui/app-sidebar.tsx", () => ({
  AppSidebar: ({ user, impersonating }: { user: { name: string }; impersonating?: boolean }) => (
    <div data-testid="sidebar-user" data-impersonating={impersonating}>
      {user.name}
    </div>
  ),
}));

const sessionMock = vi.mocked(getMe);

const user: SessionData["user"] = {
  id: "u1",
  name: "Ada",
  email: "ada@example.com",
  emailVerified: true,
  image: null,
  role: "user",
  banned: false,
  banReason: null,
  banExpires: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};
const signedIn: Me = {
  user,
  identity: { userId: "u1", impersonatedBy: null },
  approval: "approved",
};

const runBeforeLoad = (queryClient: QueryClient, href = "/") =>
  // Only the fields beforeLoad reads; the router supplies the rest.
  Route.options.beforeLoad!({ context: { queryClient }, location: { href } } as never);

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("app shell guard", () => {
  it("sends an account still waiting to the pending screen, not into the app", async () => {
    sessionMock.mockResolvedValue({ ...signedIn, approval: "pending" });

    await expect(runBeforeLoad(newClient())).rejects.toMatchObject({
      options: { to: "/pending" },
    });
  });

  it("puts the signed-in user in the route context", async () => {
    sessionMock.mockResolvedValue(signedIn);

    await expect(runBeforeLoad(newClient())).resolves.toEqual({
      user,
      identity: { userId: "u1", impersonatedBy: null },
    });
  });

  it("reads the user through the cache instead of asking again", async () => {
    sessionMock.mockResolvedValue(signedIn);
    const queryClient = newClient();

    await runBeforeLoad(queryClient);
    // beforeLoad runs on every navigation and every hover preload, so an
    // uncached read here is a round trip in front of each one.
    await runBeforeLoad(queryClient);
    await runBeforeLoad(queryClient);

    expect(sessionMock).toHaveBeenCalledTimes(1);
  });

  it("sends a signed-out visitor to the login page", async () => {
    sessionMock.mockResolvedValue(null);

    await expect(runBeforeLoad(newClient())).rejects.toMatchObject({
      options: { to: "/login" },
    });
  });

  it("brings a signed-out visitor back to where they were going after signing in", async () => {
    sessionMock.mockResolvedValue(null);

    await expect(runBeforeLoad(newClient(), "/share?text=hello")).rejects.toMatchObject({
      options: { to: "/login", search: { redirect: "/share?text=hello" } },
    });
  });

  it("stops trusting a cleared cache", async () => {
    sessionMock.mockResolvedValue(signedIn);
    const queryClient = newClient();
    await runBeforeLoad(queryClient);

    // What signing out does: the next guard has to go back to the server
    // rather than wave through the account that just left.
    queryClient.clear();
    sessionMock.mockResolvedValue(null);

    await expect(runBeforeLoad(queryClient)).rejects.toMatchObject({
      options: { to: "/login" },
    });
    expect(sessionMock).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    "preserves route impersonation state (%s) as the cached user updates",
    async (impersonating) => {
      const queryClient = newClient();
      queryClient.setQueryData(meQuery.queryKey, signedIn);

      render(
        <QueryClientProvider client={queryClient}>
          <SessionAppSidebar initialUser={user} impersonating={impersonating} />
        </QueryClientProvider>,
      );

      expect(screen.getByTestId("sidebar-user")).toHaveTextContent("Ada");
      expect(screen.getByTestId("sidebar-user")).toHaveAttribute(
        "data-impersonating",
        String(impersonating),
      );

      act(() => {
        queryClient.setQueryData(meQuery.queryKey, (current) =>
          current ? { ...current, user: { ...current.user, name: "Grace" } } : current,
        );
      });

      await waitFor(() => expect(screen.getByTestId("sidebar-user")).toHaveTextContent("Grace"));
      expect(screen.getByTestId("sidebar-user")).toHaveAttribute(
        "data-impersonating",
        String(impersonating),
      );
      expect(sessionMock).not.toHaveBeenCalled();
    },
  );
});

it.each([null, { ...user, id: "another-user" }])(
  "does not resurrect the initial sidebar after a confirmed identity change",
  async (next) => {
    const queryClient = newClient();
    queryClient.setQueryData(meQuery.queryKey, signedIn);
    render(
      <QueryClientProvider client={queryClient}>
        <SessionAppSidebar initialUser={user} />
      </QueryClientProvider>,
    );
    act(() => {
      queryClient.setQueryData(meQuery.queryKey, next && { ...signedIn, user: next });
    });
    await waitFor(() => expect(screen.queryByTestId("sidebar-user")).not.toBeInTheDocument());
  },
);
