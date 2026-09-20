import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FolderStatus } from "@chat/desktop-rpc";
import { desktopSendFields, type FolderState } from "~/modules/desktop/client/bridge.ts";
import { Composer } from "./composer.tsx";
import type { ConversationMode } from "../schema.ts";

vi.mock("../server/functions.ts", () => ({
  listChatModels: vi.fn(),
  listConversations: vi.fn(),
  getConversationWithMessages: vi.fn(),
}));
vi.mock("~/modules/skills/server/functions.ts", () => ({
  listSkills: vi.fn().mockResolvedValue([]),
}));
vi.mock("~/modules/tools/server/functions.ts", () => ({
  getWebSearchAvailability: vi.fn(),
  getResearchAvailability: vi.fn(),
}));
vi.mock("~/modules/attachments/server/functions.ts", () => ({
  getDocumentParsingAvailability: vi.fn(),
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
}));

// The bridge is what tells the page whether a machine is behind it. Faked at
// the hook so a test can be a browser tab or the desktop app, with any folder.
const NONE: FolderStatus = { folders: [], sandbox: { kind: "ready" } };
const bridge = vi.hoisted(() => ({
  desktop: false as boolean,
  status: { folders: [], sandbox: { kind: "ready" } } as FolderStatus,
  choose: vi.fn(),
}));
vi.mock("~/modules/desktop/client/bridge.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("~/modules/desktop/client/bridge.ts")>();
  return {
    ...original,
    useDesktop: () => (bridge.desktop ? {} : null),
    useDesktopOutdated: () => false,
  };
});

/** The folder state a view would own and hand to the composer. */
const folderState = () =>
  bridge.desktop
    ? {
        readiness: "ready" as const,
        status: bridge.status,
        busy: false,
        refusal: null,
        refresh: vi.fn(),
        choose: bridge.choose,
        detach: vi.fn(),
        setUpSandbox: vi.fn(),
      }
    : null;

const model = {
  id: "m1",
  providerId: "p1",
  providerName: "Provider",
  modelKey: "model",
  displayName: "Model",
  type: "chat",
  enabled: true,
  contextLength: 128_000,
  capabilities: { tools: true, reasoning: false, files: false, vision: false },
};
const client = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(["chat-models"], [model]);
  queryClient.setQueryData(["tools", "web-search", "availability"], {
    configured: false,
    enabled: false,
  });
  queryClient.setQueryData(["tools", "research", "availability"], {
    configured: false,
    enabled: false,
  });
  queryClient.setQueryData(["tools", "document-parsing", "availability"], {
    configured: false,
    enabled: false,
  });
  return queryClient;
};

function NewChat({ onSend }: { onSend: React.ComponentProps<typeof Composer>["onSend"] }) {
  const [mode, setMode] = useState<ConversationMode>("chat");
  return (
    <QueryClientProvider client={client()}>
      <Composer
        onSend={onSend}
        disabled={false}
        modelId="m1"
        onModelChange={vi.fn()}
        searchEnabled={false}
        onSearchEnabledChange={vi.fn()}
        mode={{ kind: "choose", value: mode, onChange: setMode }}
        folder={folderState()}
      />
    </QueryClientProvider>
  );
}

function ExistingChat({
  mode,
  onSend,
}: {
  mode: ConversationMode;
  onSend: React.ComponentProps<typeof Composer>["onSend"];
}) {
  return (
    <QueryClientProvider client={client()}>
      <Composer
        onSend={onSend}
        disabled={false}
        modelId="m1"
        onModelChange={vi.fn()}
        searchEnabled={false}
        onSearchEnabledChange={vi.fn()}
        mode={{ kind: "fixed", value: mode }}
        folder={folderState()}
      />
    </QueryClientProvider>
  );
}

const type = async (text: string) => {
  await userEvent.type(screen.getByRole("textbox"), text);
};
const sendButton = () => screen.getByRole("button", { name: "Send" });

beforeEach(() => {
  bridge.desktop = false;
  bridge.status = NONE;
  bridge.choose.mockClear();
});

describe("work mode", () => {
  it("uses the strip's attached and detached folders for the very next submission", async () => {
    bridge.desktop = true;
    const sent = vi.fn();
    function SharedFolderChat() {
      const [status, setStatus] = useState<FolderStatus>(NONE);
      const [queryClient] = useState(client);
      const folder: FolderState = {
        readiness: "ready",
        status,
        busy: false,
        refusal: null,
        refresh: () => {},
        setUpSandbox: () => {},
        choose: () =>
          setStatus({ folders: [{ name: "site", path: "/home/user/site", alive: true }], sandbox: { kind: "ready" } }),
        detach: () => setStatus(NONE),
      };
      return (
        <QueryClientProvider client={queryClient}>
          <Composer
            onSend={async () => {
              sent(desktopSendFields(folder));
            }}
            disabled={false}
            modelId="m1"
            onModelChange={vi.fn()}
            searchEnabled={false}
            onSearchEnabledChange={vi.fn()}
            mode={{ kind: "fixed", value: "work" }}
            folder={folder}
          />
        </QueryClientProvider>
      );
    }
    render(<SharedFolderChat />);
    await userEvent.click(screen.getByRole("button", { name: /Add a folder from this computer/ }));
    await type("Use this folder");
    await userEvent.click(sendButton());
    expect(sent).toHaveBeenLastCalledWith({
      fromDesktop: true,
      desktopFolders: [{ name: "site", path: "/home/user/site" }],
      desktopCommands: true,
    });
    await userEvent.click(screen.getByRole("button", { name: "site" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Detach site" }));
    await type("Continue without files");
    await userEvent.click(sendButton());
    expect(sent).toHaveBeenLastCalledWith({ fromDesktop: true, desktopCommands: false });
  });
  it("is not offered in a browser, where it could not be honoured", () => {
    render(<NewChat onSend={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Work with a folder" })).not.toBeInTheDocument();
    expect(screen.queryByText(/folder from this computer/)).not.toBeInTheDocument();
  });

  it("reveals the folder strip and sends without a folder", async () => {
    bridge.desktop = true;
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<NewChat onSend={onSend} />);
    // A plain chat shows nothing about folders, so the choice reads as a choice.
    expect(screen.queryByText(/folder from this computer/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Work with a folder" }));
    // The strip invites a folder rather than demanding one: work needs the
    // desktop app, and a folder can come later.
    await userEvent.click(screen.getByRole("button", { name: /Add a folder from this computer/ }));
    expect(bridge.choose).toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await type("hello");
    expect(sendButton()).toBeEnabled();
    await userEvent.click(sendButton());
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("sends once a folder is attached", async () => {
    bridge.desktop = true;
    bridge.status = { folders: [{ name: "site", path: "/home/user/site", alive: true }], sandbox: { kind: "ready" } };
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<NewChat onSend={onSend} />);
    await userEvent.click(screen.getByRole("button", { name: "Work with a folder" }));
    expect(screen.getByText("site")).toBeInTheDocument();
    await type("hello");
    expect(sendButton()).toBeEnabled();
    await userEvent.click(sendButton());
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("keeps an existing work chat readable but not continuable in a browser", async () => {
    const onSend = vi.fn();
    render(<ExistingChat mode="work" onSend={onSend} />);
    // The mode is fixed, so there is nothing to toggle.
    expect(screen.queryByRole("button", { name: "Work with a folder" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "This is a work chat. Open it in the desktop app to continue.",
    );
    await type("hello");
    expect(sendButton()).toBeDisabled();
  });

  it("asks a work chat on a new machine to pick its folder again, without blocking", async () => {
    bridge.desktop = true;
    bridge.status = { folders: [{ name: "site", path: "/home/user/site", alive: false }], sandbox: { kind: "ready" } };
    render(<ExistingChat mode="work" onSend={vi.fn().mockResolvedValue(undefined)} />);
    // The lost folder is still listed, marked, and can be chosen again.
    expect(screen.getByRole("button", { name: /site/ })).toHaveAttribute(
      "title",
      "This folder is no longer where it was.",
    );
    await type("hello");
    expect(sendButton()).toBeEnabled();
  });

  it("never shows a folder on a plain chat, even in the desktop app", () => {
    bridge.desktop = true;
    bridge.status = { folders: [{ name: "site", path: "/home/user/site", alive: true }], sandbox: { kind: "ready" } };
    render(<ExistingChat mode="chat" onSend={vi.fn()} />);
    expect(screen.queryByText("site")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
