import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProfilePage } from "./profile-page.tsx";
import { authClient } from "~/modules/auth/client.ts";
import { toast } from "sonner";

vi.mock("~/modules/auth/client.ts", () => ({
  authClient: {
    useSession: vi.fn(),
    updateUser: vi.fn(),
    changePassword: vi.fn(),
  },
  sessionUserQuery: { queryKey: ["session-user"] },
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...rest }: Record<string, unknown> & { children?: unknown }) => (
    <a href={String(to)} {...(rest as object)}>
      {children as never}
    </a>
  ),
}));

const useSessionMock = vi.mocked(authClient.useSession);
const updateUserMock = vi.mocked(authClient.updateUser);
const changePasswordMock = vi.mocked(authClient.changePassword);

// A promise that only resolves when the test says so, to observe the pending
// state of a submit button.
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const renderPage = () => {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <ProfilePage />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  useSessionMock.mockReturnValue({
    data: {
      user: { id: "u1", name: "Nico", email: "nico@example.com", role: "admin" },
      session: {},
    },
    isPending: false,
    error: null,
  } as never);
});

describe("ProfilePage", () => {
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

  it("shows a field error instead of submitting an empty name", async () => {
    const user = userEvent.setup();
    renderPage();

    const input = screen.getByLabelText("Display name");
    await user.clear(input);
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a display name.");
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("toasts when the profile cannot be saved", async () => {
    const user = userEvent.setup();
    updateUserMock.mockResolvedValue({ error: { message: "nope" } } as never);
    renderPage();

    await user.type(screen.getByLabelText("Display name"), "!{Enter}");

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not save the profile."));
  });

  it("renders the admin badge in sentence case", () => {
    renderPage();
    expect(screen.getByText("Admin")).toBeInTheDocument();
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
    expect(await screen.findByRole("status")).toHaveTextContent("Password updated.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update password" })).toBeInTheDocument();
  });
});
