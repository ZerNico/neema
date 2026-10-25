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
import { getMe } from "~/modules/auth/server/functions.ts";
import { getNeedsSetup, saveAuthSettings } from "~/modules/auth/server/signup-functions.ts";
import { signInOptionsQuery } from "~/modules/auth/queries.ts";
import type { SignInOptions } from "~/modules/auth/signup.ts";
import { Route as AppRoute } from "./_app.tsx";
import { Route as LoginRoute } from "./login.tsx";
import { Route as RegisterRoute } from "./register.tsx";
import { Route as SetupRoute } from "./setup.tsx";

vi.mock("~/modules/auth/server/functions.ts", () => ({ getMe: vi.fn() }));
vi.mock("~/modules/auth/server/signup-functions.ts", () => ({
  getNeedsSetup: vi.fn(),
  saveAuthSettings: vi.fn(),
  getSignInOptions: vi.fn(),
}));
vi.mock("~/modules/chat/server/functions.ts", () => ({ listConversations: vi.fn() }));
// The app layout aligns the page with the account's language first; this one follows the browser.
vi.mock("~/modules/language/server/functions.ts", () => ({
  getLanguage: vi.fn().mockResolvedValue({ chosen: null }),
  chooseLanguage: vi.fn(),
  noteBrowserLanguage: vi.fn().mockResolvedValue(undefined),
}));
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
const everything: SignInOptions = {
  passwordLogin: true,
  passwordSignup: true,
  passwordReset: false,
  mail: false,
  providers: [],
};

async function renderAt(
  path: "/login" | "/register" | "/setup" | `/login?${string}`,
  offered = everything,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(signInOptionsQuery.queryKey, {
    ...offered,
    providers: [...offered.providers],
  });
  const root = createRootRouteWithContext<{ queryClient: QueryClient }>()();
  const page = (route: typeof LoginRoute | typeof RegisterRoute | typeof SetupRoute, at: string) =>
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
      page(SetupRoute, "/setup"),
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
  vi.mocked(getMe)
    .mockResolvedValueOnce(null)
    .mockResolvedValue({
      user,
      identity: { userId: "u1", impersonatedBy: null },
      approval: "approved",
    } as never);
  vi.mocked(getNeedsSetup).mockResolvedValue(false);
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
    vi.mocked(authClient.signUp.email).mockResolvedValue({
      data: { token: "session" },
      error: null,
    } as never);
    const router = await renderAt("/register");
    fill("Name", "Ada");
    fill("Email", "ada@example.com");
    fill("Password", "correct horse");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText("Signed-in home")).toBeVisible();
    expect(router.state.location.pathname).toBe("/");
  });
});

describe("what the pages offer", () => {
  it("asks a new account to open its link when there is no session yet", async () => {
    vi.mocked(authClient.signUp.email).mockResolvedValue({
      data: { token: null },
      error: null,
    } as never);
    const router = await renderAt("/register");
    fill("Name", "Ada");
    fill("Email", "ada@example.com");
    fill("Password", "correct horse");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText("Check your email")).toBeVisible();
    expect(router.state.location.pathname).toBe("/register");
  });

  it("leaves only providers on the sign-in page when passwords are off", async () => {
    await renderAt("/login", {
      ...everything,
      passwordLogin: false,
      passwordSignup: false,
      providers: [{ id: "sso", label: "Work", signup: false, exclusive: false }],
    });

    expect(await screen.findByRole("button", { name: "Continue with Work" })).toBeVisible();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.queryByRole("link", { name: "Register" })).toBeNull();
  });

  it("registers only through providers that create accounts", async () => {
    await renderAt("/register", {
      ...everything,
      passwordSignup: false,
      providers: [
        { id: "sso", label: "Work", signup: true, exclusive: false },
        { id: "github", label: "GitHub", signup: false, exclusive: false },
      ],
    });

    expect(await screen.findByRole("button", { name: "Continue with Work" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Continue with GitHub" })).toBeNull();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("explains a refused OAuth sign-in on return", async () => {
    await renderAt("/login?error=signup_closed");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This sign-in can’t create new accounts here.",
    );
  });
});

describe("an instance nobody has set up", () => {
  it.each(["/login", "/register"] as const)("sends %s to setup", async (path) => {
    vi.mocked(getNeedsSetup).mockResolvedValue(true);
    const router = await renderAt(path);

    expect(await screen.findByText("Set up neema")).toBeVisible();
    expect(router.state.location.pathname).toBe("/setup");
  });

  it("creates the admin with the chosen policy and enters the app", async () => {
    vi.mocked(getNeedsSetup).mockResolvedValue(true);
    vi.mocked(authClient.signUp.email).mockResolvedValue({
      data: { user: { role: "admin" } },
      error: null,
    } as never);
    const router = await renderAt("/setup");
    fill("Name", "Ada");
    fill("Email", "ada@example.com");
    fill("Password", "correct horse");
    fireEvent.click(screen.getByRole("button", { name: "Create admin account" }));

    expect(await screen.findByText("Signed-in home")).toBeVisible();
    expect(router.state.location.pathname).toBe("/");
    expect(saveAuthSettings).toHaveBeenCalledWith({
      data: expect.objectContaining({ passwordSignup: "approval" }),
    });
  });

  it("leaves the policy alone for someone who lost the race to set it up", async () => {
    vi.mocked(getNeedsSetup).mockResolvedValue(true);
    vi.mocked(authClient.signUp.email).mockResolvedValue({
      data: { user: { role: "user" } },
      error: null,
    } as never);
    await renderAt("/setup");
    fill("Name", "Ada");
    fill("Email", "ada@example.com");
    fill("Password", "correct horse");
    fireEvent.click(screen.getByRole("button", { name: "Create admin account" }));

    expect(await screen.findByText("Signed-in home")).toBeVisible();
    expect(saveAuthSettings).not.toHaveBeenCalled();
  });

  it("is gone once the instance has an owner", async () => {
    const router = await renderAt("/setup");

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeVisible();
    expect(router.state.location.pathname).toBe("/login");
  });
});
