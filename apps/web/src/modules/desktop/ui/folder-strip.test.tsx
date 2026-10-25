import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as renderBare, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import type { PermissionLevel } from "~/modules/chat/schema.ts";
import { m } from "~/paraglide/messages.js";
import { FolderStrip } from "./folder-strip.tsx";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const render = (ui: ReactNode) =>
  renderBare(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {ui}
    </QueryClientProvider>,
  );

const noAccess = {
  queryKey: ["desktop-chat-permissions", "test"],
  load: async () => ({ chat: [], always: [] }),
  revoke: async () => {},
};

it("explains approval modes and preserves their stored values when selected", async () => {
  const changed = vi.fn();
  function Strip() {
    const [permissionLevel, setPermissionLevel] = useState<PermissionLevel>("auto");
    return (
      <FolderStrip
        folder={{
          readiness: "ready",
          status: {
            folders: [{ name: "site", path: "/home/user/site", alive: true }],
            sandbox: { kind: "ready" },
            workspace: { path: "/data/workspaces/chat" },
          },
          busy: false,
          refusal: null,
          refresh: vi.fn(),
          choose: vi.fn(),
          detach: vi.fn(),
          setUpSandbox: vi.fn(),
          access: noAccess,
        }}
        settings={{
          permissionLevel,
          onChange: (level) => {
            changed(level);
            setPermissionLevel(level);
          },
        }}
      />
    );
  }
  render(<Strip />);
  await userEvent.click(screen.getByRole("button", { name: "Permissions: Auto-approve reads" }));
  expect(await screen.findByRole("menuitemradio", { name: "Auto-approve reads" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect(
    screen.getByRole("menuitemradio", { name: "Approve each action" }),
  ).toHaveAccessibleDescription(
    "Ask before reads, changes, and commands unless already allowed for this chat.",
  );
  expect(
    screen.getByRole("menuitemradio", { name: "Auto-approve reads" }),
  ).toHaveAccessibleDescription(
    "Allow reading, listing, and searching. Ask before changes and commands.",
  );
  expect(
    screen.getByRole("menuitemradio", { name: "Auto-approve reads and changes" }),
  ).toHaveAccessibleDescription(
    "Allow reading, editing, moving files, and running commands without asking. Network access still needs separate approval.",
  );
  expect(
    screen.getByText(
      "The delete tool always asks, once for the whole list. An allowed command can still delete files. Network access and reading other paths always ask separately.",
    ),
  ).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("menuitemradio", { name: "Auto-approve reads and changes" }),
  );
  expect(changed).toHaveBeenLastCalledWith("skip");
  expect(
    screen.getByRole("menuitemradio", { name: "Auto-approve reads and changes" }),
  ).toHaveAttribute("aria-checked", "true");
  await userEvent.click(screen.getByRole("menuitemradio", { name: "Approve each action" }));
  expect(changed).toHaveBeenLastCalledWith("manual");
  await userEvent.click(screen.getByRole("menuitemradio", { name: "Auto-approve reads" }));
  expect(changed).toHaveBeenLastCalledWith("auto");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  expect(
    screen.getByRole("button", { name: "Permissions: Auto-approve reads" }),
  ).toBeInTheDocument();
});

it("replaces a lost folder by name when choosing it again", async () => {
  const choose = vi.fn();
  render(
    <FolderStrip
      folder={{
        readiness: "ready",
        status: {
          folders: [{ name: "site", path: "/home/user/site", alive: false }],
          sandbox: { kind: "ready" },
          workspace: { path: "/data/workspaces/chat" },
        },
        busy: false,
        refusal: null,
        refresh: vi.fn(),
        choose,
        detach: vi.fn(),
        setUpSandbox: vi.fn(),
        access: noAccess,
      }}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: /site/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Choose it again" }));
  expect(choose).toHaveBeenCalledExactlyOnceWith("site");
});

it("keeps the workspace implicit: no chip, only the attach invite", () => {
  render(
    <FolderStrip
      folder={{
        readiness: "ready",
        status: {
          folders: [],
          sandbox: { kind: "ready" },
          workspace: { path: "/data/workspaces/abc" },
        },
        busy: false,
        refusal: null,
        refresh: vi.fn(),
        choose: vi.fn(),
        detach: vi.fn(),
        setUpSandbox: vi.fn(),
        access: noAccess,
      }}
    />,
  );
  // The workspace is app-managed and always present, so it earns no chip;
  // the strip shows only folders the user chose.
  expect(screen.queryByText("Workspace")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Add a folder from this computer" }),
  ).toBeInTheDocument();
});

it("lists what this chat may reach and removes one from the menu", async () => {
  const revoke = vi.fn(async () => {});
  let chat = [
    { kind: "network" as const, host: "github.com", port: 22, privateNetwork: false },
    { kind: "path" as const, path: "/opt/specs" },
  ];
  const load = vi.fn(async () => ({
    chat,
    always: [{ kind: "network" as const, host: "example.com", port: 443, privateNetwork: false }],
  }));
  render(
    <FolderStrip
      folder={{
        readiness: "ready",
        status: {
          folders: [{ name: "site", path: "/home/user/site", alive: true }],
          sandbox: { kind: "ready" },
          workspace: { path: "/data/workspaces/chat" },
        },
        busy: false,
        refusal: null,
        refresh: vi.fn(),
        choose: vi.fn(),
        detach: vi.fn(),
        setUpSandbox: vi.fn(),
        access: { queryKey: ["desktop-chat-permissions", "chat"], load, revoke },
      }}
      settings={{ permissionLevel: "auto", onChange: vi.fn() }}
    />,
  );
  // Nothing is asked of the desktop until the menu opens.
  expect(load).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Permissions: Auto-approve reads" }));
  expect(await screen.findByText("Allowed in this chat")).toBeInTheDocument();
  expect(screen.getByText(/Every chat may also reach one more/)).toBeInTheDocument();
  chat = [chat[1]!];
  await userEvent.click(screen.getByRole("menuitem", { name: "Remove github.com:22" }));
  expect(revoke).toHaveBeenCalledWith({
    kind: "network",
    host: "github.com",
    port: 22,
    privateNetwork: false,
  });
  await waitFor(() =>
    expect(
      screen.queryByRole("menuitem", { name: "Remove github.com:22" }),
    ).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("menuitem", { name: "Remove /opt/specs" })).toBeInTheDocument();
});

it("counts every-chat grants in German", () => {
  expect(m.desktop_grants_always({ count: 1 }, { locale: "de" })).toContain(
    "eine weitere Freigabe",
  );
  expect(m.desktop_grants_always({ count: 3 }, { locale: "de" })).toContain("3 weitere Freigaben");
});
