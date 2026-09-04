import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView, toActivity } from "./chat-view.tsx";
import {
  branchConversation,
  getConversationWithMessages,
  sendMessage,
} from "../server/functions.ts";
import { ConfirmProvider } from "~/ui/confirm.tsx";

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock("../server/functions.ts", () => ({
  getConversationWithMessages: vi.fn(),
  listConversations: vi.fn(),
  listChatModels: vi.fn(),
  branchConversation: vi.fn(),
  sendMessage: vi.fn(),
  retryMessage: vi.fn(),
  editMessage: vi.fn(),
  stopGeneration: vi.fn(),
}));
vi.mock("~/modules/tools/server/functions.ts", () => ({
  getWebSearchAvailability: vi.fn(),
}));

// Enough router for a chip link and a navigation; the real one would drag the
// whole route tree in.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children, ...rest }: Record<string, unknown> & { children?: unknown }) => (
    <a
      href={String(to)}
      data-conversation-id={(params as { conversationId?: string } | undefined)?.conversationId}
      {...(rest as object)}
    >
      {children as never}
    </a>
  ),
  useNavigate: () => navigate,
  useRouterState: () => "/chat/c1",
}));

// The list itself is covered by message-list.test; here it only has to expose
// what the view wired onto each row.
vi.mock("./virtual-message-list.tsx", () => ({
  VirtualMessageList: ({ messages }: { messages: ReadonlyArray<Record<string, unknown>> }) => (
    <div>
      {messages.map((message) => (
        <div key={String(message.id)}>
          <span>{String(message.content)}</span>
          {(message.compactionActivities as ReadonlyArray<{ summary?: string }> | undefined)?.map(
            (activity, index) => (
              <output key={index} data-testid="compaction-activity">
                {`${String(message.id)}: ${activity.summary ?? "running"}`}
              </output>
            ),
          )}
          {message.onBranch ? (
            <button
              type="button"
              aria-label={`Branch off ${String(message.id)}`}
              disabled={Boolean(message.branchDisabled)}
              onClick={message.onBranch as () => void}
            >
              Branch off
            </button>
          ) : null}
        </div>
      ))}
    </div>
  ),
}));

vi.mock("./composer.tsx", () => ({
  Composer: ({
    onSend,
    searchEnabled,
    onSearchEnabledChange,
  }: {
    onSend: (content: string, attachmentIds: ReadonlyArray<string>) => Promise<unknown>;
    searchEnabled: boolean;
    onSearchEnabledChange: (enabled: boolean) => void;
  }) => (
    <div>
      <output data-testid="search-mode">{searchEnabled ? "on" : "off"}</output>
      <button type="button" onClick={() => onSearchEnabledChange(false)}>
        Disable search
      </button>
      <button type="button" onClick={() => void onSend("hello", [])}>
        Send test message
      </button>
    </div>
  ),
}));

vi.mock("../client/use-message-stream.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../client/use-message-stream.ts")>()),
  useMessageStream: () => ({
    text: "",
    reasoning: "",
    reasoningSeen: false,
    tools: [],
    compactions: [],
    lastSeq: 0,
    status: "complete",
  }),
}));

vi.mock("~/modules/attachments/client/use-attachment-uploads.ts", () => ({
  useAttachmentUploads: () => ({
    items: [],
    attachmentIds: [],
    uploading: false,
    hasError: false,
    isFull: false,
    notice: null,
    queued: false,
    addFiles: vi.fn(),
    remove: vi.fn(),
    seed: vi.fn(),
    submit: (send: (ids: ReadonlyArray<string>) => unknown) => send([]),
    cancelQueue: vi.fn(),
    markClaimed: vi.fn(),
    reset: vi.fn(),
    dismissNotice: vi.fn(),
  }),
}));

const branchMock = vi.mocked(branchConversation);
const conversationMock = vi.mocked(getConversationWithMessages);
const sendMock = vi.mocked(sendMessage);

const BASE = new Date("2026-03-01T12:00:00Z");

const message = (id: string, role: "user" | "assistant" | "system", content: string) => ({
  id,
  conversationId: "c1",
  role,
  status: "complete" as const,
  content,
  reasoning: "",
  modelId: "m1",
  usage: null,
  error: null,
  createdAt: BASE,
  completedAt: BASE,
  editedAt: null,
});

type Payload = ReturnType<typeof basePayload>;

const basePayload = (branchedFrom: { conversationId: string; title: string | null } | null) => ({
  conversation: {
    id: "c1",
    userId: "u1",
    title: "Current chat",
    modelId: "m1",
    branchedFrom: branchedFrom?.conversationId ?? null,
    createdAt: BASE,
    updatedAt: BASE,
    lastMessageAt: BASE,
  },
  messages: [message("m-user", "user", "u1"), message("m-answer", "assistant", "a1")],
  pendingChunks: [],
  toolCalls: [],
  attachments: [],
  branchedFrom,
  compactionEvents: [] as Array<{
    id: string;
    messageId: string;
    checkpointId: string | null;
    beforeTurnIndex: number;
    passIndex: number;
    scope: "history" | "active_rounds";
    status: "running" | "complete" | "error";
    outcome: "summary" | "hard_truncation" | null;
    summary: string | null;
    error: { code: string; message: string } | null;
    createdAt: Date;
    completedAt: Date | null;
  }>,
});

const payload = (
  branchedFrom: Parameters<typeof basePayload>[0],
  overrides: Partial<Payload> = {},
) => ({ ...basePayload(branchedFrom), ...overrides });

const renderView = (
  branchedFrom: Parameters<typeof basePayload>[0] = null,
  overrides: Partial<Payload> = {},
) => {
  const client = new QueryClient({
    // The payload is seeded, not fetched — the server functions are mocks.
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["conversation", "c1"], payload(branchedFrom, overrides));
  client.setQueryData(
    ["chat-models"],
    [
      {
        id: "m1",
        providerId: "provider-1",
        providerName: "Provider One",
        modelKey: "m1",
        displayName: "Model One",
        type: "chat",
        enabled: true,
        contextLength: 128_000,
        capabilities: { reasoning: false, tools: true, vision: false, files: false },
      },
    ],
  );
  client.setQueryData(["tools", "web-search", "availability"], {
    configured: true,
    enabled: true,
  });
  return render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <Suspense fallback={null}>
          <ChatView conversationId="c1" />
        </Suspense>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("toActivity", () => {
  const row = {
    id: "tool-1",
    arguments: {},
    result: {},
    status: "complete" as const,
    turnIndex: 1,
    callIndex: 2,
    error: null,
  };

  it("hydrates save_memory as summary-only memory activity", () => {
    expect(
      toActivity({
        ...row,
        toolName: "save_memory",
        arguments: { content: "private memory" },
        result: {
          outcome: "updated",
          content: "private memory",
          sources: [{ url: "https://should-not-appear.dev" }],
        },
      }),
    ).toEqual({
      family: "memory",
      callId: "tool-1",
      name: "save_memory",
      turnIndex: 1,
      callIndex: 2,
      status: "complete",
      outcome: "updated",
    });
  });

  it("hydrates existing tool names as web activity", () => {
    expect(
      toActivity({
        ...row,
        toolName: "web_search",
        arguments: { queries: ["effect"] },
        result: { resultCount: 2 },
      }),
    ).toEqual({
      family: "web",
      callId: "tool-1",
      name: "web_search",
      turnIndex: 1,
      callIndex: 2,
      targets: ["effect"],
      status: "complete",
      resultCount: 2,
    });
  });
});

describe("ChatView search mode", () => {
  it("starts enabled for an available tool-capable model", () => {
    renderView();
    expect(screen.getByTestId("search-mode")).toHaveTextContent("on");
  });

  it("resets a one-message opt-out after a successful send", async () => {
    conversationMock.mockResolvedValue(payload(null) as never);
    sendMock.mockResolvedValue({} as never);
    renderView();

    fireEvent.click(screen.getByRole("button", { name: "Disable search" }));
    expect(screen.getByTestId("search-mode")).toHaveTextContent("off");

    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith({
        data: {
          conversationId: "c1",
          modelId: "m1",
          content: "hello",
          searchEnabled: false,
          attachmentIds: [],
        },
      }),
    );
    await waitFor(() => expect(screen.getByTestId("search-mode")).toHaveTextContent("on"));
  });
});

describe("ChatView branching", () => {
  it("links back to the conversation it was branched from", () => {
    renderView({ conversationId: "c0", title: "Root chat" });

    expect(screen.getByText("Branched from")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Root chat" });
    expect(link).toHaveAttribute("data-conversation-id", "c0");
  });

  it("names a source whose title has not resolved yet like the sidebar does", () => {
    renderView({ conversationId: "c0", title: null });
    expect(screen.getByRole("link", { name: "New chat…" })).toBeInTheDocument();
  });

  it("shows no lineage chip for a conversation that was started fresh", () => {
    renderView();
    expect(screen.queryByText("Branched from")).toBeNull();
  });

  it("offers branching on the answer only, not on the question", () => {
    renderView();
    expect(screen.getByRole("button", { name: "Branch off m-answer" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Branch off m-user" })).toBeNull();
  });

  it("forks at the clicked answer and opens the copy", async () => {
    branchMock.mockResolvedValue({ conversationId: "c2" } as never);
    renderView();

    screen.getByRole("button", { name: "Branch off m-answer" }).click();

    await waitFor(() =>
      expect(branchMock).toHaveBeenCalledWith({
        data: { conversationId: "c1", messageId: "m-answer" },
      }),
    );
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/chat/$conversationId",
        params: { conversationId: "c2" },
      }),
    );
  });

  it("attaches completed compaction to the assistant response that performed it", async () => {
    renderView(null, {
      compactionEvents: [
        {
          id: "compact-1",
          messageId: "m-answer",
          checkpointId: "cp1",
          beforeTurnIndex: 0,
          passIndex: 0,
          scope: "history",
          status: "complete",
          outcome: "summary",
          summary: "Earlier: they settled on an append-only ledger.",
          error: null,
          createdAt: BASE,
          completedAt: BASE,
        },
      ],
    });

    const activity = await screen.findByTestId("compaction-activity");
    expect(activity).toHaveTextContent("m-answer: Earlier: they settled on an append-only ledger.");
  });

  it("marks nothing when the conversation has no compaction event", async () => {
    renderView();
    expect(await screen.findByText("a1")).toBeInTheDocument();
    expect(screen.queryByTestId("compaction-activity")).toBeNull();
  });
});
