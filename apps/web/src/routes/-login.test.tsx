import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authClient } from "~/modules/auth/client.ts";
import { getSessionIdentity, getSessionUser } from "~/modules/auth/server/functions.ts";
import { getApprovalStatus } from "~/modules/auth/server/signup-functions.ts";
import { signInProvidersQuery } from "~/modules/auth/ui/sign-in-providers.tsx";
import { Route as AppRoute } from "./_app.tsx";
import { Route as LoginRoute } from "./login.tsx";
import { Route as RegisterRoute } from "./register.tsx";

vi.mock("~/modules/auth/server/functions.ts", () => ({
  getSessionUser: vi.fn(),
  getSessionIdentity: vi.fn(),
}));
vi.mock("~/modules/auth/server/signup-functions.ts", () => ({ getApprovalStatus: vi.fn() }));
vi.mock("~/modules/auth/server/oauth-functions.ts", () => ({ getSignInProviders: vi.fn() }));
vi.mock("~/modules/chat/server/functions.ts", () => ({ listConversations: vi.fn() }));
// Better Auth's client is a proxy spyOn cannot patch; only the calls this page makes.
vi.mock("~/modules/auth/client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/auth/client.ts")>()),
  authClient: { signIn: { email: vi.fn() }, signUp: { email: vi.fn() } },
}));

const user = { id: "u1", name: "Ada", email: "ada@example.com" };

/**
 * The real sign-in pages and the real app guard, with a stand-in shell: the
 * bug lives between one's cached "signed out" and the other's read of it.
 */
async function renderAt(path: "/login" | "/register") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(signInProvidersQuery.queryKey, []);
  const root = createRootRouteWithContext<{ queryClient: QueryClient }>()();
  const page = (route: typeof LoginRoute | typeof RegisterRoute, at: string) =>
    createRoute({
      getParentRoute: () => root,
      path: at,
      // Both pages declare it as a function; the option's type also admits schemas.
      validateSearch: route.options.validateSearch as (search: Record<string, unknown>) => {
        redirect?: string;
      },
      beforeLoad: async (options) => {
        await route.options.beforeLoad!(options as never);
      },
      component: route.options.component!,
    });
  const app = createRoute({
    getParentRoute: () => root,
    id: "_app",
    beforeLoad: async (options) => {
      await AppRoute.options.beforeLoad!(options as never);
    },
  });
  const home = createRoute({
    getParentRoute: () => app,
    path: "/",
    component: () => <p>Signed-in home</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([
      page(LoginRoute, "/login"),
      page(RegisterRoute, "/register"),
      app.addChildren([home]),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient },
  });
  await router.load();
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Signed out while the page's own guard runs; signed in once the form posts.
  vi.mocked(getSessionUser)
    .mockResolvedValueOnce(null)
    .mockResolvedValue(user as never);
  vi.mocked(getSessionIdentity).mockResolvedValue({ userId: "u1", impersonatedBy: null });
  vi.mocked(getApprovalStatus).mockResolvedValue("approved");
});

const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("after a successful sign-in", () => {
  it("enters the app instead of bouncing back to the sign-in page", async () => {
    vi.mocked(authClient.signIn.email).mockResolvedValue({ data: {}, error: null } as never);
    const router = await renderAt("/login");
    fill("Email", "ada@example.com");
    fill("Password", "correct horse");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Signed-in home")).toBeVisible();
    expect(router.state.location.pathname).toBe("/");
  });

  it("enters the app after registering too", async () => {
    vi.mocked(authClient.signUp.email).mockResolvedValue({ data: {}, error: null } as never);
    const router = await renderAt("/register");
    fill("Name", "Ada");
    fill("Email", "ada@example.com");
    fill("Password", "correct horse");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText("Signed-in home")).toBeVisible();
    expect(router.state.location.pathname).toBe("/");
  });
});
