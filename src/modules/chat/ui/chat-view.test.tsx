import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "./chat-view.tsx";
import { branchConversation } from "../server/functions.ts";
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

vi.mock("./composer.tsx", () => ({ Composer: () => null }));

vi.mock("../client/use-message-stream.ts", () => ({
  useMessageStream: () => ({
    text: "",
    reasoning: "",
    reasoningSeen: false,
    tools: [],
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

const BASE = new Date("2026-03-01T12:00:00Z");

const message = (id: string, role: "user" | "assistant", content: string) => ({
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

const payload = (branchedFrom: { conversationId: string; title: string | null } | null) => ({
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
});

const renderView = (branchedFrom: Parameters<typeof payload>[0] = null) => {
  const client = new QueryClient({
    // The payload is seeded, not fetched — the server functions are mocks.
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["conversation", "c1"], payload(branchedFrom));
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
});
