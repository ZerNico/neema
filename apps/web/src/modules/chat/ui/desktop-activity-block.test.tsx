import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DesktopActivityBlock } from "./desktop-activity-block.tsx";
import type { DesktopToolActivity } from "../client/use-message-stream.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// A file row offers to read the file it names, which is a mutation like any
// other. These tests are about the row in a browser, where there is no machine
// behind it and no conversation in context: no affordance either way.
const show = (element: ReactNode) =>
  render(<QueryClientProvider client={new QueryClient()}>{element}</QueryClientProvider>);

const running = (over: Partial<DesktopToolActivity> = {}): DesktopToolActivity => ({
  family: "desktop",
  callId: "call-1",
  name: "run_command",
  status: "running",
  turnIndex: 0,
  callIndex: 0,
  args: { command: "pnpm test" },
  ...over,
});

describe("DesktopActivityBlock", () => {
  it("names a file by its folder and the rest, or just its name, with the whole path on hover", () => {
    const roots = [{ name: "Downloads", path: "/Users/me/Downloads" }];
    const read = (path: string, over: Partial<DesktopToolActivity> = {}) =>
      running({ name: "read_local_file", args: { path }, ...over });
    const { unmount } = show(
      <DesktopActivityBlock activity={read("/Users/me/Downloads/q3/report.pdf")} roots={roots} />,
    );
    expect(screen.getByText("Reading Downloads/q3/report.pdf")).toHaveAttribute(
      "title",
      "/Users/me/Downloads/q3/report.pdf",
    );
    unmount();
    const workspace = "/Users/me/.data/desktop/workspaces/aafe548d/01a0fc67/image.png";
    const { unmount: next } = show(
      <DesktopActivityBlock activity={read(workspace)} roots={roots} />,
    );
    expect(screen.getByText("Reading image.png")).toBeInTheDocument();
    next();
    // A call that ended without a result says what it could not do, not that it is doing it.
    show(<DesktopActivityBlock activity={read(workspace, { status: "error" })} roots={roots} />);
    expect(screen.getByText("Couldn’t read image.png")).toBeInTheDocument();
  });

  it("is pressable while the message is still streaming", async () => {
    const decide = vi.fn();
    show(<DesktopActivityBlock activity={running()} approval={{ kind: "command", decide }} />);
    // The clarification card is disabled mid-stream because answering it ends
    // the turn. This one is the inverse: the generation is parked on it.
    await userEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(decide).toHaveBeenCalledWith("allow");
  });

  it("offers a blanket grant naming only its own kind", async () => {
    const decide = vi.fn();
    show(<DesktopActivityBlock activity={running()} approval={{ kind: "command", decide }} />);
    expect(screen.getByText("pnpm test")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Let it run programs for this chat" }),
    );
    expect(decide).toHaveBeenCalledWith("allow-rest");

    decide.mockClear();
    show(
      <DesktopActivityBlock
        activity={running({
          callId: "call-2",
          name: "write_local_file",
          args: { path: "src/index.ts" },
        })}
        approval={{ kind: "edit", decide }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Let it change files for this chat" }),
    ).toBeInTheDocument();
  });

  it("asks for network access for this answer, this chat or every chat", async () => {
    const decide = vi.fn();
    show(
      <DesktopActivityBlock
        activity={running({
          name: "request_network_access",
          args: { host: "github.com", port: 22 },
        })}
        approval={{ kind: "network", decide }}
      />,
    );
    expect(screen.getByText("Allow network access on this computer")).toBeInTheDocument();
    expect(screen.getByText("github.com:22")).toBeInTheDocument();
    for (const [name, choice] of [
      ["Allow for this answer", "allow"],
      ["Allow in this chat", "allow-chat"],
      ["Always allow", "allow-always"],
      ["Deny", "deny"],
    ] as const) {
      await userEvent.click(screen.getByRole("button", { name }));
      expect(decide).toHaveBeenLastCalledWith(choice);
    }
  });

  it("asks to let commands read a path for this answer, this chat or every chat", async () => {
    const decide = vi.fn();
    show(
      <DesktopActivityBlock
        activity={running({
          name: "request_path_access",
          args: { path: "/Users/alex/Downloads/spec.pdf" },
        })}
        approval={{ kind: "path", decide }}
      />,
    );
    expect(screen.getByText("Let commands read this")).toBeInTheDocument();
    expect(screen.getByText("/Users/alex/Downloads/spec.pdf")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Allow in this chat" }));
    expect(decide).toHaveBeenLastCalledWith("allow-chat");
  });

  it("warns what local network services open before asking", async () => {
    const decide = vi.fn();
    show(
      <DesktopActivityBlock
        activity={running({ name: "request_local_services", args: {} })}
        approval={{ kind: "local", decide }}
      />,
    );
    expect(screen.getByText("Let commands use local network services")).toBeInTheDocument();
    expect(screen.getByText(/could be reached from your network/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Allow for this answer" }));
    expect(decide).toHaveBeenLastCalledWith("allow");
  });

  it("offers the SSH agent for this chat only", async () => {
    const decide = vi.fn();
    show(
      <DesktopActivityBlock
        activity={running({ name: "request_ssh_agent", args: {} })}
        approval={{ kind: "ssh-agent", decide }}
      />,
    );
    expect(
      screen.getByText("Let commands in this chat sign in with your SSH keys"),
    ).toBeInTheDocument();
    expect(screen.getByText(/key files stay unreadable/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Always allow" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow for this answer" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Allow in this chat" }));
    expect(decide).toHaveBeenLastCalledWith("allow-chat");
  });

  it("names a private network request as one", () => {
    show(
      <DesktopActivityBlock
        activity={running({
          name: "request_network_access",
          args: { host: "git.internal", privateNetwork: true },
        })}
        approval={{ kind: "network", decide: vi.fn() }}
      />,
    );
    expect(screen.getByText("Allow access to your private network")).toBeInTheDocument();
    expect(screen.getByText("git.internal:443")).toBeInTheDocument();
  });

  it("names the destination in network approval and progress", () => {
    const activity = running({
      name: "request_network_access",
      args: { host: "picsum.photos" },
    });
    show(
      <DesktopActivityBlock activity={activity} approval={{ kind: "network", decide: vi.fn() }} />,
    );
    expect(screen.getByText("picsum.photos:443")).toBeInTheDocument();
    show(<DesktopActivityBlock activity={activity} />);
    expect(screen.getByText("Requesting network access to picsum.photos:443")).toBeInTheDocument();
  });

  it("offers no blanket grant for a delete and lists every path", () => {
    const decide = vi.fn();
    show(
      <DesktopActivityBlock
        activity={running({
          callId: "call-3",
          name: "delete_local_file",
          args: { paths: ["Downloads/dup.pdf", "Downloads/old.zip"] },
        })}
        approval={{ kind: "delete", decide }}
      />,
    );
    expect(screen.getByText("Delete 2 files in Downloads")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "dup.pdf",
      "old.zip",
    ]);
    expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /for this chat/ })).not.toBeInTheDocument();
  });

  it("groups a mixed-folder delete under each folder name", () => {
    show(
      <DesktopActivityBlock
        activity={running({
          callId: "call-3b",
          name: "delete_local_file",
          args: { paths: ["Downloads/dup.pdf", "site/tmp.log"] },
        })}
        approval={{ kind: "delete", decide: vi.fn() }}
      />,
    );
    expect(screen.getByText("Delete 2 files from this computer")).toBeInTheDocument();
    expect(screen.getByText("Downloads")).toBeInTheDocument();
    expect(screen.getByText("site")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "dup.pdf",
      "tmp.log",
    ]);
  });

  it("still names a single-file delete with its full path", () => {
    show(
      <DesktopActivityBlock
        activity={running({
          callId: "call-3c",
          name: "delete_local_file",
          args: { paths: ["Downloads/dup.pdf"] },
        })}
        approval={{ kind: "delete", decide: vi.fn() }}
      />,
    );
    expect(screen.getByText("Delete from this computer")).toBeInTheDocument();
    expect(screen.getByText("Downloads/dup.pdf")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("groups absolute paths under the attempt's roots, longest match first", () => {
    show(
      <DesktopActivityBlock
        activity={running({
          callId: "call-3d",
          name: "delete_local_file",
          args: {
            paths: [
              "/workspaces/abc/notes.txt",
              "/home/nico/site/sub/old.log",
              "/home/nico/site/README.md",
            ],
          },
        })}
        approval={{ kind: "delete", decide: vi.fn() }}
        roots={[
          { name: "workspace", path: "/workspaces/abc" },
          { name: "site", path: "/home/nico/site" },
          // Nested roots: the inner one must claim its own paths.
          { name: "sub", path: "/home/nico/site/sub" },
        ]}
      />,
    );
    expect(screen.getByText("workspace")).toBeInTheDocument();
    expect(screen.getByText("sub")).toBeInTheDocument();
    expect(screen.getByText("site")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "notes.txt",
      "old.log",
      "README.md",
    ]);
  });

  it("still names a delete that used the older single path argument", () => {
    show(
      <DesktopActivityBlock
        activity={running({ callId: "call-4", name: "delete_local_file", args: { path: "old/" } })}
      />,
    );
    expect(screen.getByText("Deleting old/")).toBeInTheDocument();
  });

  it("summarises a many-file delete while it is running", () => {
    show(
      <DesktopActivityBlock
        activity={running({
          callId: "call-5",
          name: "delete_local_file",
          args: { paths: ["a.txt", "b.txt"] },
        })}
      />,
    );
    expect(screen.getByText("Deleting 2 files")).toBeInTheDocument();
  });

  it("shows a plain row, with no way to act, once the call is decided", () => {
    show(
      <DesktopActivityBlock
        activity={running({
          status: "complete",
          result: {
            v: 1,
            ok: true,
            summary: "Ran pnpm test",
            detail: "3 passed",
            truncated: false,
          },
        })}
      />,
    );
    expect(screen.getByText("Ran pnpm test")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument();
  });

  it("reads as history in a browser, where no approval is offered", () => {
    show(<DesktopActivityBlock activity={running()} />);
    expect(screen.getByText("Running pnpm test")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deny" })).not.toBeInTheDocument();
  });
});
