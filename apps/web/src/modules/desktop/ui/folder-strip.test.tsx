import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import type { PermissionLevel } from "~/modules/chat/schema.ts";
import { FolderStrip } from "./folder-strip.tsx";

it("explains approval modes and preserves their stored values when selected", async () => {
  const changed = vi.fn();
  function Strip() {
    const [permissionLevel, setPermissionLevel] = useState<PermissionLevel>("auto");
    return (
      <FolderStrip
        folder={{
          readiness: "ready",
          status: { folders: [{ name: "site", alive: true }], sandbox: { kind: "ready" } },
          busy: false,
          refusal: null,
          refresh: vi.fn(),
          choose: vi.fn(),
          detach: vi.fn(),
          setUpSandbox: vi.fn(),
        }}
        settings={{
          permissionLevel,
          onChange: (patch) => {
            changed(patch);
            setPermissionLevel(patch.permissionLevel!);
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
    "Allow reading, editing, moving files, and running commands without asking.",
  );
  expect(
    screen.getByText("The delete tool always asks. An allowed command can still delete files."),
  ).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("menuitemradio", { name: "Auto-approve reads and changes" }),
  );
  expect(changed).toHaveBeenLastCalledWith({ permissionLevel: "skip" });
  expect(
    screen.getByRole("menuitemradio", { name: "Auto-approve reads and changes" }),
  ).toHaveAttribute("aria-checked", "true");
  await userEvent.click(screen.getByRole("menuitemradio", { name: "Approve each action" }));
  expect(changed).toHaveBeenLastCalledWith({ permissionLevel: "manual" });
  await userEvent.click(screen.getByRole("menuitemradio", { name: "Auto-approve reads" }));
  expect(changed).toHaveBeenLastCalledWith({ permissionLevel: "auto" });
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
        status: { folders: [{ name: "site", alive: false }], sandbox: { kind: "ready" } },
        busy: false,
        refusal: null,
        refresh: vi.fn(),
        choose,
        detach: vi.fn(),
        setUpSandbox: vi.fn(),
      }}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: /site/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Choose it again" }));
  expect(choose).toHaveBeenCalledExactlyOnceWith("site");
});
