import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProfilePage } from "./profile-page.tsx";
import { authClient, sessionUserQuery, type SessionData } from "~/modules/auth/client.ts";
import { toast } from "sonner";
import { signInOptionsQuery } from "~/modules/auth/queries.ts";

vi.mock("~/modules/auth/client.ts", () => ({
  authClient: {
    updateUser: vi.fn(),
    changePassword: vi.fn(),
    listAccounts: vi.fn(async () => ({ data: [] as unknown[], error: null })),
  },
  // The page reads the session the app shell already loaded, so every render
  // here seeds that cache. Fetching instead would mean it found nothing.
  sessionUserQuery: {
    queryKey: ["session-user"],
    staleTime: Infinity,
    queryFn: () => {
      throw new Error("ProfilePage must read the seeded session, not refetch it");
    },
  },
}));

vi.mock("~/modules/auth/server/signup-functions.ts", () => ({ getSignInOptions: vi.fn() }));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...rest }: Record<string, unknown> & { children?: unknown }) => (
    <a href={String(to)} {...(rest as object)}>
      {children as never}
    </a>
  ),
}));

const updateUserMock = vi.mocked(authClient.updateUser);
const changePasswordMock = vi.mocked(authClient.changePassword);
const SESSION_USER: SessionData["user"] = {
  id: "u1",
  name: "Nico",
  email: "nico@example.com",
  emailVerified: true,
  image: null,
  role: "admin",
  banned: false,
  banReason: null,
  banExpires: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

// A promise that only resolves when the test says so, to observe the pending
// state of a submit button.
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const renderPage = (
  client = new QueryClient(),
  passwordLogin = true,
  providers: { id: string; label: string; signup: boolean; exclusive: boolean }[] = [],
) => {
  client.setQueryData(sessionUserQuery.queryKey, SESSION_USER);
  client.setQueryData(signInOptionsQuery.queryKey, {
    passwordLogin,
    passwordSignup: passwordLogin,
    passwordReset: false,
    mail: false,
    providers,
  });
  render(
    <QueryClientProvider client={client}>
      <ProfilePage />
    </QueryClientProvider>,
  );
  return client;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ProfilePage", () => {
  it("offers no password change to an account its provider alone signs in", async () => {
    vi.mocked(authClient.listAccounts).mockResolvedValueOnce({
      data: [{ id: "a1", providerId: "sso", accountId: "subject" }],
      error: null,
    } as never);
    renderPage(new QueryClient(), true, [
      { id: "sso", label: "Work", signup: true, exclusive: true },
      { id: "github", label: "GitHub", signup: true, exclusive: false },
    ]);
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.queryByLabelText("Current password")).toBeNull();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    // Another provider could never sign this account in, so none is offered.
    expect(screen.queryByText("GitHub")).toBeNull();
  });

  it("offers no password change where passwords are off", () => {
    renderPage(new QueryClient(), false);
    expect(screen.getByLabelText("Display name")).toBeInTheDocument();
    expect(screen.queryByLabelText("Current password")).toBeNull();
  });

  it("submits the display name on Enter and keeps the label while pending", async () => {
    const user = userEvent.setup();
    const pending = deferred<{ error: null }>();
    updateUserMock.mockReturnValue(pending.promise as never);
    renderPage();

    const input = screen.getByLabelText("Display name");
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();

    await user.clear(input);
    await user.type(input, "Nico F{Enter}");

    await waitFor(() => expect(updateUserMock).toHaveBeenCalledWith({ name: "Nico F" }));
    expect(save).toHaveAttribute("aria-busy", "true");
    expect(save.querySelector('[data-slot="spinner"]')).toBeInTheDocument();
    expect(save).toHaveTextContent("Save");

    pending.resolve({ error: null });
    await waitFor(() => expect(save).not.toHaveAttribute("aria-busy"));
  });

  it("updates the cached session user immediately after saving", async () => {
    const user = userEvent.setup();
    const client = new QueryClient();
    client.setQueryData(sessionUserQuery.queryKey, SESSION_USER);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    updateUserMock.mockResolvedValue({ error: null } as never);
    renderPage(client);

    const input = screen.getByLabelText("Display name");
    await user.clear(input);
    await user.type(input, "  Nico F  ");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateUserMock).toHaveBeenCalledWith({ name: "Nico F" }));
    expect(client.getQueryData(sessionUserQuery.queryKey)).toEqual({
      ...SESSION_USER,
      name: "Nico F",
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: sessionUserQuery.queryKey,
      exact: true,
    });
  });

  it("shows a field error instead of submitting an empty name", async () => {
    const user = userEvent.setup();
    renderPage();

    const input = screen.getByLabelText("Display name");
    await user.clear(input);
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a display name.");
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("toasts without changing the cached user when the profile cannot be saved", async () => {
    const user = userEvent.setup();
    const client = new QueryClient();
    client.setQueryData(sessionUserQuery.queryKey, SESSION_USER);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    updateUserMock.mockResolvedValue({ error: { message: "nope" } } as never);
    renderPage(client);

    await user.type(screen.getByLabelText("Display name"), "!{Enter}");

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not save the profile."));
    expect(client.getQueryData(sessionUserQuery.queryKey)).toEqual(SESSION_USER);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("acknowledges the saved name without overwriting a later edit", async () => {
    const user = userEvent.setup();
    const pending = deferred<{ error: null }>();
    updateUserMock.mockReturnValueOnce(pending.promise as never);
    updateUserMock.mockResolvedValueOnce({ error: null } as never);
    const client = renderPage();
    const input = screen.getByLabelText("Display name");
    await user.clear(input);
    await user.type(input, "Submitted A{Enter}");
    await waitFor(() => expect(updateUserMock).toHaveBeenCalledWith({ name: "Submitted A" }));
    await user.clear(input);
    await user.type(input, "Later B");
    pending.resolve({ error: null });
    await waitFor(() =>
      expect(client.getQueryData(sessionUserQuery.queryKey)).toMatchObject({ name: "Submitted A" }),
    );
    expect(input).toHaveValue("Later B");
    const save = screen.getByRole("button", { name: /^(Save|Saved)$/ });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    await waitFor(() => expect(updateUserMock).toHaveBeenLastCalledWith({ name: "Later B" }));
    await waitFor(() => expect(save).toBeDisabled());
  });

  it("renders the admin badge in sentence case", () => {
    renderPage();
    expect(screen.getByText("Admin")).toBeInTheDocument();
    const name = screen.getByText(SESSION_USER.name);
    expect(name).toHaveClass("min-w-0", "truncate");
    expect(name).toHaveAttribute("title", SESSION_USER.name);
  });

  it("validates the password form and separates success from error", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText("Current password"), "old-secret");
    await user.type(screen.getByLabelText("New password"), "short{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "New password must be at least 8 characters.",
    );
    expect(changePasswordMock).not.toHaveBeenCalled();

    changePasswordMock.mockResolvedValue({ error: { message: "Wrong password" } } as never);
    await user.clear(screen.getByLabelText("New password"));
    await user.type(screen.getByLabelText("New password"), "long-enough-secret{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Wrong password");

    changePasswordMock.mockResolvedValue({ error: null } as never);
    await user.type(screen.getByLabelText("Current password"), "old-secret");
    await user.type(screen.getByLabelText("New password"), "long-enough-secret{Enter}");
    // The button itself confirms, for a moment, in place of its label.
    expect(await screen.findByRole("button", { name: "Password updated" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
