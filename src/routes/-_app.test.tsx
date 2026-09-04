import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route, SessionAppSidebar } from "./_app.tsx";
import { sessionUserQuery, type SessionData } from "~/modules/auth/client.ts";
import { getSessionUser } from "~/modules/auth/server/functions.ts";

vi.mock("~/modules/auth/server/functions.ts", () => ({ getSessionUser: vi.fn() }));
vi.mock("~/modules/chat/server/functions.ts", () => ({ listConversations: vi.fn() }));
vi.mock("~/modules/chat/ui/app-sidebar.tsx", () => ({
  AppSidebar: ({ user }: { user: { name: string } }) => (
    <div data-testid="sidebar-user">{user.name}</div>
  ),
}));

const sessionMock = vi.mocked(getSessionUser);

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

const runBeforeLoad = (queryClient: QueryClient) =>
  // Only the field beforeLoad reads; the router supplies the rest.
  (
    Route.options.beforeLoad as unknown as (args: {
      context: { queryClient: QueryClient };
    }) => Promise<{ user: typeof user }>
  )({ context: { queryClient } });

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("app shell guard", () => {
  it("puts the signed-in user in the route context", async () => {
    sessionMock.mockResolvedValue(user as never);

    await expect(runBeforeLoad(newClient())).resolves.toEqual({ user });
  });

  it("reads the user through the cache instead of asking again", async () => {
    sessionMock.mockResolvedValue(user as never);
    const queryClient = newClient();

    await runBeforeLoad(queryClient);
    // beforeLoad runs on every navigation and every hover preload, so an
    // uncached read here is a round trip in front of each one.
    await runBeforeLoad(queryClient);
    await runBeforeLoad(queryClient);

    expect(sessionMock).toHaveBeenCalledTimes(1);
  });

  it("sends a signed-out visitor to the login page", async () => {
    sessionMock.mockResolvedValue(null as never);

    await expect(runBeforeLoad(newClient())).rejects.toMatchObject({
      options: { to: "/login" },
    });
  });

  it("stops trusting a cleared cache", async () => {
    sessionMock.mockResolvedValue(user as never);
    const queryClient = newClient();
    await runBeforeLoad(queryClient);

    // What signing out does — the next guard has to go back to the server
    // rather than wave through the account that just left.
    queryClient.clear();
    sessionMock.mockResolvedValue(null as never);

    await expect(runBeforeLoad(queryClient)).rejects.toMatchObject({
      options: { to: "/login" },
    });
    expect(sessionMock).toHaveBeenCalledTimes(2);
  });

  it("updates the sidebar when the cached session user changes", async () => {
    const queryClient = newClient();
    queryClient.setQueryData(sessionUserQuery.queryKey, user);

    render(
      <QueryClientProvider client={queryClient}>
        <SessionAppSidebar initialUser={user} />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("sidebar-user")).toHaveTextContent("Ada");

    act(() => {
      queryClient.setQueryData(sessionUserQuery.queryKey, (current) =>
        current ? { ...current, name: "Grace" } : current,
      );
    });

    await waitFor(() => expect(screen.getByTestId("sidebar-user")).toHaveTextContent("Grace"));
    expect(sessionMock).not.toHaveBeenCalled();
  });
});
