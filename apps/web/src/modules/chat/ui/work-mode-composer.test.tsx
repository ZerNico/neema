import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FolderStatus } from "@chat/desktop-rpc";
import { Composer } from "./composer.tsx";
import type { ConversationMode } from "../schema.ts";

vi.mock("../server/functions.ts", () => ({
  listChatModels: vi.fn(),
  listConversations: vi.fn(),
  getConversationWithMessages: vi.fn(),
}));
vi.mock("~/modules/skills/server/functions.ts", () => ({ listSkills: vi.fn() }));
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
const bridge = vi.hoisted(() => ({
  desktop: false as boolean,
  status: { kind: "none" } as FolderStatus,
  choose: vi.fn(),
}));
vi.mock("~/modules/desktop/client/bridge.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("~/modules/desktop/client/bridge.ts")>();
  return {
    ...original,
    useDesktop: () => (bridge.desktop ? {} : null),
    useDesktopOutdated: () => false,
    useFolder: () =>
      bridge.desktop
        ? {
            status: bridge.status,
            busy: false,
            refresh: vi.fn(),
            choose: bridge.choose,
            detach: vi.fn(),
            setUpSandbox: vi.fn(),
            setNetwork: vi.fn(),
          }
        : null,
  };
});

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
        conversationId="c1"
        onSend={onSend}
        disabled={false}
        modelId="m1"
        onModelChange={vi.fn()}
        searchEnabled={false}
        onSearchEnabledChange={vi.fn()}
        mode={{ kind: "fixed", value: mode }}
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
  bridge.status = { kind: "none" };
  bridge.choose.mockClear();
});

describe("work mode", () => {
  it("is not offered in a browser, where it could not be honoured", () => {
    render(<NewChat onSend={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Work with a folder" })).not.toBeInTheDocument();
    expect(screen.queryByText(/folder from this computer/)).not.toBeInTheDocument();
  });

  it("reveals the folder strip and blocks sending until a folder is chosen", async () => {
    bridge.desktop = true;
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<NewChat onSend={onSend} />);
    // A plain chat shows nothing about folders, so the choice reads as a choice.
    expect(screen.queryByText(/folder from this computer/)).not.toBeInTheDocument();
    await type("hello");
    expect(sendButton()).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "Work with a folder" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Choose a folder from this computer to continue.",
    );
    expect(sendButton()).toBeDisabled();
    // The nudge is the strip itself: pressing it opens the native picker.
    await userEvent.click(
      screen.getByRole("button", { name: /Choose a folder from this computer/ }),
    );
    expect(bridge.choose).toHaveBeenCalled();
    // Enter must not slip past the disabled button either.
    await userEvent.keyboard("{Enter}");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("sends once a folder is attached", async () => {
    bridge.desktop = true;
    bridge.status = {
      kind: "attached",
      name: "site",
      sandbox: { kind: "ready" },
      network: "packages",
    };
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

  it("asks a work chat on a new machine to pick its folder again", () => {
    bridge.desktop = true;
    bridge.status = { kind: "unresolved", name: "site" };
    render(<ExistingChat mode="work" onSend={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: /Choose site again to continue/ }),
    ).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
  });

  it("never shows a folder on a plain chat, even in the desktop app", () => {
    bridge.desktop = true;
    bridge.status = {
      kind: "attached",
      name: "site",
      sandbox: { kind: "ready" },
      network: "packages",
    };
    render(<ExistingChat mode="chat" onSend={vi.fn()} />);
    expect(screen.queryByText("site")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
