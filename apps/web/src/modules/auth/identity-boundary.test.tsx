import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createPortal } from "react-dom";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IdentityBoundary,
  IDENTITY_CHANGE_KEY,
  identityNavigation,
  useIdentityBoundary,
} from "./identity-boundary.tsx";
import type { SessionIdentity } from "./identity.ts";
import { AccountMenu } from "./account-menu.tsx";
import { SidebarProvider } from "~/ui/primitives/sidebar";
import { getSessionIdentity } from "./server/functions.ts";
import { UsersPage } from "~/modules/admin/ui/users-page.tsx";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { useSync } from "~/modules/sync/client/use-sync.ts";
import { FakeEventSource } from "../../../tests/fixtures/event-source.ts";

const mocks = vi.hoisted(() => ({
  signal: null as (() => void) | null,
  sessionChanged: null as
    | ((value: { isPending: boolean; error: unknown; data: unknown }) => void)
    | null,
  unsubscribe: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  signOut: vi.fn(),
  list: vi.fn(),
  toast: vi.fn(),
  cleanup: vi.fn(),
  navigate: vi.fn(),
}));
// A callback ref, not a ref object: the lint rule reads `hostRef` in JSX
// as a ref access during render, and a plain function is what we assert on.
const hostRef = vi.fn();
vi.mock("./server/functions.ts", () => ({ getSessionIdentity: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("sonner", () => ({ toast: { error: mocks.toast } }));
vi.mock("./client.ts", () => ({
  authClient: {
    $store: {
      atoms: {
        $sessionSignal: {
          listen: (callback: () => void) => {
            mocks.signal = callback;
            return mocks.unsubscribe;
          },
        },
        session: {
          listen: (callback: typeof mocks.sessionChanged) => {
            mocks.sessionChanged = callback;
            return () => {};
          },
        },
      },
    },
    admin: { impersonateUser: mocks.start, stopImpersonating: mocks.stop, listUsers: mocks.list },
    signOut: mocks.signOut,
  },
  // The users page reads who "you" are from the same identity the boundary
  // pins, so impersonation controls and the boundary cannot disagree.
  sessionIdentityQuery: {
    queryKey: ["session-identity"],
    queryFn: async () => ({ userId: "admin", impersonatedBy: null }),
  },
}));
vi.mock("~/modules/admin/ui/groups-page.tsx", () => ({
  membershipsQuery: { queryKey: ["memberships"], queryFn: async () => [] },
}));
// The approval queue is the users page's other half and has its own tests;
// here it would only add a suspense boundary to the impersonation controls.
vi.mock("./ui/pending-accounts.tsx", () => ({
  PendingAccounts: () => null,
  pendingAccountsQuery: { queryKey: ["admin", "pending-accounts"], queryFn: async () => [] },
}));

const original = { userId: "admin", impersonatedBy: null };
const active = { userId: "target", impersonatedBy: "admin" };
const identity = vi.mocked(getSessionIdentity);
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

function Account({ impersonating = true }: { impersonating?: boolean }) {
  return (
    <SidebarProvider>
      <AccountMenu
        user={{ name: "Target", email: "target@example.test", role: "user" }}
        impersonating={impersonating}
      />
    </SidebarProvider>
  );
}
async function openAccount() {
  await userEvent.click(screen.getByRole("button", { name: /Target, target@example.test/ }));
  await screen.findByRole("menuitem", { name: "Sign out" });
}

function Probe() {
  const boundary = useIdentityBoundary();
  useSync(boundary?.reconcile);
  useEffect(() => () => mocks.cleanup(), []);
  return (
    <div ref={hostRef}>
      Private content
      <button onClick={() => void boundary?.changeIdentity(async () => {}, "/admin/users")}>
        Switch
      </button>
    </div>
  );
}
function mount(children = <Probe />, initial: SessionIdentity = original) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(["private-data"], { secret: "old-user-data" });
  const view = render(
    <QueryClientProvider client={client}>
      <IdentityBoundary identity={initial}>{children}</IdentityBoundary>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

beforeEach(() => {
  vi.clearAllMocks();
  hostRef.mockClear();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  identity.mockReset().mockResolvedValue(original);
  mocks.start.mockReset().mockResolvedValue({ error: null });
  mocks.stop.mockReset().mockResolvedValue({ error: null });
  mocks.signOut.mockReset().mockResolvedValue({ error: null });
  mocks.list.mockResolvedValue({
    data: {
      users: [
        { id: "admin", name: "Admin", email: "admin@example.test", role: "admin" },
        { id: "target", name: "Target", email: "target@example.test", role: "user" },
        { id: "other-admin", name: "Other admin", email: "other@example.test", role: "admin" },
        { id: "banned", name: "Banned", email: "banned@example.test", role: "user", banned: true },
      ],
    },
    error: null,
  });
  vi.spyOn(identityNavigation, "replace").mockImplementation(() => {});
  localStorage.clear();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("authenticated identity boundary", () => {
  it("keeps SSR content during unresolved hydration and transient initial errors", async () => {
    const pending = deferred<typeof original>();
    identity.mockReturnValueOnce(pending.promise);
    mount();
    expect(screen.getByText("Private content")).toBeVisible();
    await act(async () => {
      pending.reject(new Error("offline"));
    });
    expect(screen.getByText("Private content")).toBeVisible();
    expect(identityNavigation.replace).not.toHaveBeenCalled();
  });

  it("unmounts streams, cancels and clears queries before exact local replacement and signals only a nonce", async () => {
    const { client } = mount();
    await act(async () => {});
    const source = FakeEventSource.instances.at(-1)!;
    const cancel = vi.spyOn(client, "cancelQueries");
    vi.mocked(identityNavigation.replace).mockImplementation(() => {
      expect(mocks.cleanup).toHaveBeenCalledTimes(1);
      expect(source.close).toHaveBeenCalledOnce();
      expect(client.getQueryCache().getAll()).toEqual([]);
    });
    fireEvent.click(screen.getByText("Switch"));
    await waitFor(() => expect(identityNavigation.replace).toHaveBeenCalledWith("/admin/users"));
    expect(cancel).toHaveBeenCalled();
    expect(screen.queryByText("Private content")).not.toBeInTheDocument();
    expect(localStorage.getItem(IDENTITY_CHANGE_KEY)).toMatch(/^[a-f0-9-]{36}$/);
    source.emit("sync", { type: "message.status", conversationId: "old" });
    expect(client.getQueryCache().getAll()).toEqual([]);
  });

  it("replaces sibling tabs once without rebroadcasting or trusting event URLs", async () => {
    const { client } = mount();
    await act(async () => {});
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    fireEvent(
      window,
      new StorageEvent("storage", { key: IDENTITY_CHANGE_KEY, newValue: "https://untrusted.test" }),
    );
    fireEvent(
      window,
      new StorageEvent("storage", { key: IDENTITY_CHANGE_KEY, newValue: "second" }),
    );
    expect(identityNavigation.replace).toHaveBeenCalledExactlyOnceWith("/");
    expect(setItem).not.toHaveBeenCalled();
    expect(client.getQueryCache().getAll()).toEqual([]);
  });

  it.each([null, active, { userId: "admin", impersonatedBy: "other" }])(
    "authoritatively checks native changes: %j",
    async (next) => {
      mount();
      await act(async () => {});
      identity.mockResolvedValue(next);
      act(() => mocks.signal?.());
      await waitFor(() =>
        expect(identityNavigation.replace).toHaveBeenCalledWith(next ? "/" : "/login"),
      );
      expect(screen.queryByText("Private content")).not.toBeInTheDocument();
    },
  );

  it("revalidates silently on focus: coalesced, never hidden, and a transport error changes nothing", async () => {
    mount(
      <>
        <Probe />
        <input aria-label="Draft" defaultValue="Keep this draft" />
        {createPortal(<div>Private popup</div>, document.body)}
      </>,
    );
    await act(async () => {});
    const source = FakeEventSource.instances.at(-1)!;
    const node = screen.getByText("Private content");
    const pending = deferred<typeof original>();
    identity.mockReturnValueOnce(pending.promise);
    fireEvent.focus(window);
    fireEvent(document, new Event("visibilitychange"));
    expect(identity).toHaveBeenCalledTimes(2);
    // The check is speculative, so nothing is concealed, torn down or restarted
    // while it is in flight: hiding here is what replayed every animation on
    // screen and dropped the sync stream on each tab return.
    expect(screen.getByText("Private content")).toBeVisible();
    expect(screen.getByText("Private popup")).toBeVisible();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(source.close).not.toHaveBeenCalled();
    expect(mocks.cleanup).not.toHaveBeenCalled();
    // Host refs stay attached: detaching them (what `<Activity hidden>` does) is
    // exactly the signal Motion reads as a remount.
    expect(hostRef).not.toHaveBeenCalledWith(null);
    await act(async () => pending.reject(new Error("offline")));
    expect(hostRef).not.toHaveBeenCalledWith(null);
    expect(identityNavigation.replace).not.toHaveBeenCalled();
    expect(screen.getByText("Private content")).toBe(node);
    expect(screen.getByRole("textbox", { name: "Draft" })).toHaveValue("Keep this draft");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it.each([null, active])("replaces the document when a focus check finds %j", async (next) => {
    const { client } = mount();
    await act(async () => {});
    const source = FakeEventSource.instances.at(-1)!;
    identity.mockResolvedValue(next);
    fireEvent.focus(window);
    await waitFor(() =>
      expect(identityNavigation.replace).toHaveBeenCalledExactlyOnceWith(next ? "/" : "/login"),
    );
    expect(screen.queryByText("Private content")).not.toBeInTheDocument();
    expect(source.close).toHaveBeenCalledOnce();
    expect(client.getQueryCache().getAll()).toEqual([]);
  });

  it("treats a refused identity check as a logout, not a transport error", async () => {
    mount();
    await act(async () => {});
    identity.mockRejectedValueOnce(new Error("Unauthorized"));
    fireEvent.focus(window);
    await waitFor(() =>
      expect(identityNavigation.replace).toHaveBeenCalledExactlyOnceWith("/login"),
    );
  });

  it("blocks BFCache snapshots and discards pre-suspension identity responses", async () => {
    const old = deferred<typeof original>();
    identity.mockReturnValueOnce(old.promise);
    mount();
    fireEvent(window, new PageTransitionEvent("pagehide", { persisted: true }));
    expect(screen.getByText("Private content")).not.toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Checking session…");
    const fresh = deferred<typeof original>();
    identity.mockReturnValueOnce(fresh.promise);
    fireEvent(window, new PageTransitionEvent("pageshow", { persisted: true }));
    await act(async () => old.resolve(original));
    expect(screen.getByText("Private content")).not.toBeVisible();
    await act(async () => fresh.resolve(original));
    expect(screen.getByText("Private content")).toBeVisible();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it.each([
    ["query", "Unauthorized", "/login"],
    ["mutation", "Unauthorized", "/login"],
  ] as const)(
    "ends the session on a 401 from any %s without a confirmation round trip",
    async (kind, body, destination) => {
      const { client } = mount();
      await act(async () => {});
      expect(identity).toHaveBeenCalledTimes(1);
      const failing = () => Promise.reject(new Error(body));
      await act(async () => {
        await (
          kind === "query"
            ? client.fetchQuery({ queryKey: ["refused"], queryFn: failing, retry: false })
            : client.getMutationCache().build(client, { mutationFn: failing }).execute(undefined)
        ).catch(() => {});
      });
      await waitFor(() =>
        expect(identityNavigation.replace).toHaveBeenCalledExactlyOnceWith(destination),
      );
      expect(identity).toHaveBeenCalledTimes(1);
      expect(client.getQueryCache().getAll()).toEqual([]);
    },
  );

  it("leaves ordinary request failures to their callers", async () => {
    const { client } = mount();
    await act(async () => {});
    await act(async () => {
      await client
        .fetchQuery({
          queryKey: ["broken"],
          queryFn: () => Promise.reject(new Error("Forbidden")),
          retry: false,
        })
        .catch(() => {});
    });
    expect(identityNavigation.replace).not.toHaveBeenCalled();
    expect(screen.getByText("Private content")).toBeVisible();
  });

  it("ignores unresolved native hydration and errors but checks a resolved native logout", async () => {
    mount();
    await act(async () => {});
    act(() => mocks.sessionChanged?.({ isPending: true, error: null, data: null }));
    act(() =>
      mocks.sessionChanged?.({ isPending: false, error: new Error("offline"), data: null }),
    );
    expect(identity).toHaveBeenCalledTimes(1);
    identity.mockResolvedValue(null);
    act(() => mocks.sessionChanged?.({ isPending: false, error: null, data: null }));
    await waitFor(() => expect(identityNavigation.replace).toHaveBeenCalledWith("/login"));
  });

  it("does not adopt a client navigation's new identity in the old authenticated tree", async () => {
    const { client, rerender } = mount();
    await act(async () => {});
    rerender(
      <QueryClientProvider client={client}>
        <IdentityBoundary identity={active}>
          <Probe />
        </IdentityBoundary>
      </QueryClientProvider>,
    );
    expect(screen.queryByText("Private content")).not.toBeInTheDocument();
    await waitFor(() => expect(identityNavigation.replace).toHaveBeenCalledWith("/"));
  });

  it("does not let a late user query repopulate a cleared identity cache", async () => {
    const { client } = mount();
    await act(async () => {});
    const pending = deferred<string>();
    const query = client
      .fetchQuery({ queryKey: ["late-private-data"], queryFn: () => pending.promise })
      .catch(() => {});
    fireEvent.click(screen.getByText("Switch"));
    await waitFor(() => expect(identityNavigation.replace).toHaveBeenCalled());
    await act(async () => {
      pending.resolve("old private result");
      await query;
    });
    expect(client.getQueryCache().getAll()).toEqual([]);
  });

  it("ignores late checks after unmount and cleans native listeners", async () => {
    const pending = deferred<typeof active>();
    identity.mockReturnValueOnce(pending.promise);
    const { unmount } = mount();
    unmount();
    await act(async () => pending.resolve(active));
    expect(identityNavigation.replace).not.toHaveBeenCalled();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
  });

  it("gates SSE reconnect events until identity is verified and disposes before old events can invalidate", async () => {
    const { client } = mount();
    await act(async () => {});
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => source.emit("open"));
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const pending = deferred<typeof active>();
    identity.mockReturnValueOnce(pending.promise);
    source.emit("error");
    source.emit("open");
    source.emit("sync", { type: "memory.changed" });
    expect(invalidate).not.toHaveBeenCalled();
    await act(async () => pending.resolve(active));
    expect(source.close).toHaveBeenCalledOnce();
    source.emit("sync", { type: "memory.changed" });
    expect(invalidate).not.toHaveBeenCalled();
    expect(client.getQueryCache().getAll()).toEqual([]);
  });
});

describe("impersonation controls", () => {
  it("confirms private-data access and model actions, supports cancellation, then starts at root", async () => {
    const user = userEvent.setup();
    mount(
      <ConfirmProvider>
        <UsersPage />
      </ConfirmProvider>,
    );
    await user.click(await screen.findByRole("button", { name: "Actions for Target" }));
    await user.click(await screen.findByRole("menuitem", { name: "Impersonate user" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("private data");
    expect(screen.getByRole("alertdialog")).toHaveTextContent("including model requests");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.start).not.toHaveBeenCalled();
    expect(identityNavigation.replace).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Actions for Target" }));
    await user.click(await screen.findByRole("menuitem", { name: "Impersonate user" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Impersonate user" }),
    );
    await waitFor(() => expect(identityNavigation.replace).toHaveBeenCalledExactlyOnceWith("/"));
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith({ userId: "target" });
  });

  it.each(["Other admin", "Banned"])("does not offer impersonation for %s", async (name) => {
    const user = userEvent.setup();
    mount(
      <ConfirmProvider>
        <UsersPage />
      </ConfirmProvider>,
    );
    await user.click(await screen.findByRole("button", { name: `Actions for ${name}` }));
    expect(screen.queryByRole("menuitem", { name: "Impersonate user" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Actions for Admin" })).toBeDisabled();
  });

  it("disables repeated starts while pending and never redirects or signals an API failure", async () => {
    const user = userEvent.setup();
    const pending = deferred<{ error: { message: string } }>();
    mocks.start.mockReturnValueOnce(pending.promise);
    mount(
      <ConfirmProvider>
        <UsersPage />
      </ConfirmProvider>,
    );
    await user.click(await screen.findByRole("button", { name: "Actions for Target" }));
    await user.click(await screen.findByRole("menuitem", { name: "Impersonate user" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Impersonate user" }),
    );
    expect(screen.getByRole("button", { name: "Actions for Target" })).toBeDisabled();
    await act(async () => pending.resolve({ error: { message: "denied" } }));
    expect(mocks.toast).toHaveBeenCalledWith("Could not impersonate the user.", { description: "Denied." });
    expect(identityNavigation.replace).not.toHaveBeenCalled();
    expect(localStorage.getItem(IDENTITY_CHANGE_KEY)).toBeNull();
  });

  it("retains the warning and stable pending stop label on errors, then retries to admin users", async () => {
    identity.mockResolvedValue(active);
    const pending = deferred<{ error: { message: string } }>();
    mocks.stop.mockReturnValueOnce(pending.promise);
    mount(
      <>
        <Account />
        <div>Route content</div>
      </>,
      active,
    );
    await act(async () => {});
    await openAccount();
    fireEvent.click(screen.getByRole("menuitem", { name: "Stop impersonating" }));
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Stop impersonating" })).toHaveAttribute(
        "aria-disabled",
        "true",
      ),
    );
    expect(screen.getByRole("menuitem", { name: "Stop impersonating" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(mocks.signOut).not.toHaveBeenCalled();
    await act(async () => pending.resolve({ error: { message: "missing backup" } }));
    expect(screen.getByText("Target")).toBeVisible();
    expect(screen.getByText("Impersonating")).toBeVisible();
    expect(mocks.toast).toHaveBeenCalledWith(
      "Could not stop impersonating. Retry, or sign out and sign in with your admin account.",
    );
    expect(await screen.findByRole("menuitem", { name: "Sign out" })).toBeVisible();
    expect(identityNavigation.replace).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("menuitem", { name: "Stop impersonating" }));
    await waitFor(() =>
      expect(identityNavigation.replace).toHaveBeenCalledExactlyOnceWith("/admin/users"),
    );
  });

  it("offers native sign-out recovery rather than manual cookie restoration", async () => {
    identity.mockResolvedValue(active);
    mocks.stop.mockResolvedValueOnce({ error: { message: "revoked backup" } });
    mount(<Account />, active);
    await act(async () => {});
    await openAccount();
    fireEvent.click(screen.getByRole("menuitem", { name: "Stop impersonating" }));
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Sign out" })).not.toHaveAttribute(
        "aria-disabled",
        "true",
      ),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    await waitFor(() =>
      expect(identityNavigation.replace).toHaveBeenCalledExactlyOnceWith("/login"),
    );
    expect(mocks.signOut).toHaveBeenCalledOnce();
  });
  it("always offers impersonated sign out and blocks stop while it is pending", async () => {
    identity.mockResolvedValue(active);
    const pending = deferred<{ error: { message: string } }>();
    mocks.signOut.mockReturnValueOnce(pending.promise);
    const { client } = mount(<Account />, active);
    await openAccount();
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Sign out" })).toHaveAttribute(
        "aria-busy",
        "true",
      ),
    );
    expect(screen.getByRole("menuitem", { name: "Stop impersonating" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Stop impersonating" }));
    expect(mocks.stop).not.toHaveBeenCalled();
    await act(async () => pending.resolve({ error: { message: "offline" } }));
    expect(mocks.toast).toHaveBeenCalledWith("Could not sign out. Please retry.", {
      description: "Offline.",
    });
    expect(client.getQueryData(["private-data"])).toBeDefined();
    expect(identityNavigation.replace).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Sign out" })).not.toHaveAttribute(
        "aria-disabled",
        "true",
      ),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    await waitFor(() =>
      expect(identityNavigation.replace).toHaveBeenCalledExactlyOnceWith("/login"),
    );
    expect(client.getQueryCache().getAll()).toEqual([]);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("keeps the ordinary account menu and client-side sign out", async () => {
    const { client } = mount(<Account impersonating={false} />);
    expect(screen.queryByText("Impersonating")).not.toBeInTheDocument();
    expect(screen.getByText("target@example.test")).toBeVisible();
    await openAccount();
    expect(screen.queryByRole("menuitem", { name: "Stop impersonating" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Change server" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/login" }));
    expect(client.getQueryCache().getAll()).toEqual([]);
    expect(identityNavigation.replace).not.toHaveBeenCalled();
  });

  it("offers the desktop shell's server chooser and reports its refusal", async () => {
    const changeServer = vi.fn(async () => {});
    vi.stubGlobal("__chatDesktop", {
      auth: { onTicket: () => () => {}, canChangeServer: true, changeServer },
    });
    mount(<Account impersonating={false} />);
    await openAccount();
    fireEvent.click(screen.getByRole("menuitem", { name: "Change server" }));
    await waitFor(() => expect(changeServer).toHaveBeenCalledOnce());
    expect(mocks.signOut).not.toHaveBeenCalled();
    changeServer.mockRejectedValueOnce(new Error("The server is fixed by CHAT_DESKTOP_SERVER."));
    await openAccount();
    fireEvent.click(screen.getByRole("menuitem", { name: "Change server" }));
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith("The server is fixed by CHAT_DESKTOP_SERVER."),
    );
  });

  it("hides the server switch while the shell pins its server", async () => {
    vi.stubGlobal("__chatDesktop", {
      auth: { onTicket: () => () => {}, canChangeServer: false, changeServer: vi.fn() },
    });
    mount(<Account impersonating={false} />);
    await openAccount();
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Change server" })).not.toBeInTheDocument();
  });
});
