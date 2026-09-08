import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { AskUserBlock } from "./ask-user-block.tsx";
import type { DisplayMessage } from "./message-list.tsx";
import { useSync } from "~/modules/sync/client/use-sync.ts";
import { FakeEventSource } from "../../../../tests/fixtures/event-source.ts";
import { ChatView, toActivity } from "./chat-view.tsx";
import {
  answerQuestion,
  branchConversation,
  getConversationWithMessages,
  editMessage,
  retryMessage,
  sendMessage,
} from "../server/functions.ts";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { DetailPanelProvider } from "~/ui/detail-panel.tsx";
import { formatQuestionResponse, type QuestionResponse } from "~/modules/tools/ask-user-schema.ts";

const { navigate, markClaimed, resetUploads, streamProbe } = vi.hoisted(() => ({
  navigate: vi.fn(),
  markClaimed: vi.fn(),
  resetUploads: vi.fn(),
  streamProbe: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

vi.mock("../server/functions.ts", () => ({
  getConversationWithMessages: vi.fn(),
  listConversations: vi.fn(),
  listChatModels: vi.fn(),
  branchConversation: vi.fn(),
  sendMessage: vi.fn(),
  answerQuestion: vi.fn(),
  retryMessage: vi.fn(),
  editMessage: vi.fn(),
  stopGeneration: vi.fn(),
}));
vi.mock("../client/time-zone.ts", () => ({ browserTimeZone: () => "Europe/Berlin" }));

vi.mock("~/modules/tools/server/functions.ts", () => ({
  getWebSearchAvailability: vi.fn(),
}));
vi.mock("~/modules/knowledge/server/functions.ts", () => ({
  listKnowledgeCollections: vi.fn(),
  getKnowledgeCollection: vi.fn(),
}));
vi.mock("~/modules/agents/server/functions.ts", () => ({
  listAgents: vi.fn(),
  getAgent: vi.fn(),
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
        <div
          key={String(message.id)}
          data-message-id={String(message.id)}
          data-inherited-sources={JSON.stringify(message.inheritedSources)}
          data-collection-ids={
            Array.isArray(message.collectionIds) ? message.collectionIds.join(",") : undefined
          }
        >
          <span>{String(message.content)}</span>
          {(message.toolActivities as DisplayMessage["toolActivities"]).map((activity) =>
            activity.family === "ask" ? (
              <AskUserBlock
                key={activity.callId}
                activity={activity}
                messageStatus={String(message.status)}
                {...(message.questionActions as DisplayMessage["questionActions"])}
              />
            ) : null,
          )}
          {(message.compactionActivities as ReadonlyArray<{ summary?: string }> | undefined)?.map(
            (activity, index) => (
              <output key={index} data-testid="compaction-activity">
                {`${String(message.id)}: ${activity.summary ?? "running"}`}
              </output>
            ),
          )}
          {message.editState ? <output>Editing {String(message.id)}</output> : null}
          {message.onEdit ? (
            <button
              type="button"
              aria-label={`Edit ${String(message.id)}`}
              disabled={Boolean(message.editDisabled)}
              onClick={message.onEdit as () => void}
            >
              Edit message
            </button>
          ) : null}
          {message.onRetry ? (
            <button
              type="button"
              aria-label={`Retry ${String(message.id)}`}
              disabled={Boolean(message.retryDisabled)}
              onClick={message.onRetry as () => void}
            >
              Retry same
            </button>
          ) : null}
          {message.onRetryWith ? (
            <button
              type="button"
              aria-label={`Retry ${String(message.id)} with m2`}
              disabled={Boolean(message.retryDisabled)}
              onClick={() => (message.onRetryWith as (modelId: string) => void)("m2")}
            >
              Retry with Model Two
            </button>
          ) : null}
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
    modelId,
    onModelChange,
    searchEnabled,
    onSearchEnabledChange,
    disabled,
    controlsDisabled,
    textareaDisabled,
  }: {
    disabled: boolean;
    controlsDisabled?: boolean;
    textareaDisabled?: boolean;
    onSend: (content: string, attachmentIds: ReadonlyArray<string>) => Promise<unknown>;
    modelId: string | null;
    onModelChange: (modelId: string) => void;
    searchEnabled: boolean;
    onSearchEnabledChange: (enabled: boolean) => void;
  }) => (
    <div>
      <textarea aria-label="Unrelated composer draft" defaultValue="" disabled={textareaDisabled} />
      <output data-testid="composer-model">{modelId}</output>
      <button type="button" disabled={controlsDisabled} onClick={() => onModelChange("m2")}>
        Select Model Two
      </button>
      <output data-testid="search-mode">{searchEnabled ? "on" : "off"}</output>
      <button
        type="button"
        disabled={controlsDisabled}
        onClick={() => onSearchEnabledChange(false)}
      >
        Disable search
      </button>
      <button type="button" disabled={disabled} onClick={() => void onSend("hello", [])}>
        Send test message
      </button>
    </div>
  ),
}));

vi.mock("../client/use-message-stream.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../client/use-message-stream.ts")>()),
  useMessageStream: (...args: unknown[]) => {
    streamProbe(...args);
    return {
      text: "",
      reasoning: "",
      reasoningSeen: false,
      tools: [],
      compactions: [],
      lastSeq: 0,
      status: "complete",
    };
  },
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
    markClaimed,
    reset: resetUploads,
    dismissNotice: vi.fn(),
  }),
}));

const branchMock = vi.mocked(branchConversation);
const conversationMock = vi.mocked(getConversationWithMessages);
const sendMock = vi.mocked(sendMessage);
const retryMock = vi.mocked(retryMessage);

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
  questionResponse: null as unknown,
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
  pendingChunks: [] as Array<{
    seq: number;
    kind: "text" | "reasoning" | "tool" | "compaction";
    delta: string;
  }>,
  agent: null,
  collectionIds: [] as string[],
  generations: [] as Array<{
    messageId: string;
    agent: { name: string; icon: string } | null;
    collectionIds: ReadonlyArray<string>;
    knowledgeMode: "none" | "context" | "retrieval";
  }>,
  toolCalls: [] as Array<Parameters<typeof toActivity>[0] & { messageId: string }>,
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

function SyncProbe() {
  useSync();
  return null;
}

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
      {
        id: "m2",
        providerId: "provider-1",
        providerName: "Provider One",
        modelKey: "m2",
        displayName: "Model Two",
        type: "chat",
        enabled: true,
        contextLength: 128_000,
        capabilities: { reasoning: false, tools: false, vision: false, files: false },
      },
    ],
  );
  client.setQueryData(
    ["knowledge", "collections"],
    [
      {
        id: "c-contracts",
        name: "Contracts",
        description: "",
        audience: "private",
        canEdit: true,
        ownerName: null,
        documentCount: 1,
        readyCount: 1,
        failedCount: 0,
        pendingCount: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  );
  client.setQueryData(["tools", "web-search", "availability"], {
    configured: true,
    enabled: true,
  });
  return render(
    <QueryClientProvider client={client}>
      <SyncProbe />
      <ConfirmProvider>
        <DetailPanelProvider>
          <Suspense fallback={null}>
            <ChatView conversationId="c1" />
          </Suspense>
        </DetailPanelProvider>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => vi.unstubAllGlobals());

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

const askQuestions = [
  {
    question: "Which direction?",
    options: [{ label: "Simple" }, { label: "Detailed" }],
    multiSelect: false,
  },
];
const askRow = {
  id: "ask-1",
  messageId: "m-answer",
  toolName: "ask_user",
  arguments: { questions: askQuestions },
  result: { v: 1, outcome: "presented", questions: askQuestions },
  status: "complete" as const,
  turnIndex: 1,
  callIndex: 2,
  error: null,
};

const answerMock = vi.mocked(answerQuestion);
const editMock = vi.mocked(editMessage);
const structuredReply = (
  response: QuestionResponse = { kind: "answers", answers: [{ selected: [0], custom: "" }] },
) => ({
  ...message("structured-user", "user", formatQuestionResponse(askQuestions, response)!),
  questionResponse: { v: 1, response },
});

const resolvedPayload = (response?: QuestionResponse) =>
  payload(null, {
    toolCalls: [askRow],
    messages: [
      ...basePayload(null).messages,
      structuredReply(response),
      message("next-answer", "assistant", "Continuing"),
    ],
  });

describe("ChatView inline question answers", () => {
  it("folds only explicitly tagged replies into resolved cards without a blank message row", () => {
    const { container } = renderView(null, resolvedPayload());
    expect(screen.getByLabelText("Your answers")).toBeInTheDocument();
    expect(screen.getByText("Simple")).toBeInTheDocument();
    expect(screen.queryByText("Q1: Simple")).not.toBeInTheDocument();
    expect(container.querySelector('[data-message-id="structured-user"]')).toBeNull();
    expect(container.querySelector('[data-answer-message-id="structured-user"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Edit answers" })).toBeEnabled();
  });

  it("resolves a skipped card from cross-tab sync even if the next generation failed", async () => {
    renderView(null, { toolCalls: [askRow] });
    const next = resolvedPayload({ kind: "skip" });
    next.messages[next.messages.length - 1] = {
      ...next.messages.at(-1)!,
      status: "error" as never,
    };
    conversationMock.mockResolvedValueOnce(next as never);
    await act(async () =>
      FakeEventSource.instances.at(-1)!.emit("sync", {
        type: "message.created",
        conversationId: "c1",
        messageId: "structured-user",
      }),
    );
    await screen.findByText("Skipped");
    expect(screen.queryByText(structuredReply({ kind: "skip" }).content)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skip and continue" })).not.toBeInTheDocument();
  });

  it("edits indexed answers through the existing mutation with no content or attachments", async () => {
    const revised: QuestionResponse = { kind: "answers", answers: [{ selected: [1], custom: "" }] };
    conversationMock.mockResolvedValueOnce(resolvedPayload(revised) as never);
    editMock.mockResolvedValueOnce({
      conversationId: "c1",
      assistantMessageId: "next-answer",
    } as never);
    renderView(null, resolvedPayload());
    const composer = screen.getByRole("textbox", { name: "Unrelated composer draft" });
    fireEvent.change(composer, { target: { value: "Do not send this" } });
    fireEvent.click(screen.getByRole("button", { name: "Disable search" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit answers" }));
    expect(screen.getByRole("button", { name: "Simple" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Detailed" }));
    fireEvent.click(screen.getByRole("button", { name: "Save answers" }));
    await waitFor(() =>
      expect(editMock).toHaveBeenCalledWith({
        data: {
          conversationId: "c1",
          messageId: "structured-user",
          modelId: "m1",
          searchEnabled: false,
          timeZone: "Europe/Berlin",
          attachmentIds: [],
          questionResponse: revised,
        },
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Save answers" })).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Detailed")).toBeInTheDocument();
    expect(composer).toHaveValue("Do not send this");
    expect(screen.getByTestId("search-mode")).toHaveTextContent("off");
    expect(markClaimed).not.toHaveBeenCalled();
    expect(resetUploads).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(answerMock).not.toHaveBeenCalled();
    expect(streamProbe.mock.calls.at(-1)?.[3]).toBe(1);
  });

  it("keeps answer edits local while typing and changing composer settings", () => {
    renderView(null, resolvedPayload());
    fireEvent.click(screen.getByRole("button", { name: "Edit answers" }));
    const draft = screen.getByRole("textbox", { name: "Or write your own answer" });
    fireEvent.change(draft, { target: { value: "Unsaved revision" } });
    expect(screen.getByRole("textbox", { name: "Unrelated composer draft" })).toBeEnabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Unrelated composer draft" }), {
      target: { value: "A separate draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Select Model Two" }));
    fireEvent.click(screen.getByRole("button", { name: "Disable search" }));
    expect(draft).toHaveValue("Unsaved revision");
    expect(screen.getByTestId("composer-model")).toHaveTextContent("m2");
    expect(screen.getByTestId("search-mode")).toHaveTextContent("off");
    for (const name of ["Send test message", "Retry next-answer", "Edit m-user"]) {
      expect(screen.getByRole("button", { name })).toBeEnabled();
    }
    expect(editMock).not.toHaveBeenCalled();
  });

  it.each(["send", "retry"])(
    "discards the local answer edit on %s, without saving it",
    async (action) => {
      conversationMock.mockResolvedValueOnce(resolvedPayload() as never);
      if (action === "send") sendMock.mockResolvedValueOnce({} as never);
      else retryMock.mockResolvedValueOnce({} as never);
      renderView(null, resolvedPayload());
      fireEvent.click(screen.getByRole("button", { name: "Edit answers" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Or write your own answer" }), {
        target: { value: "Discard this revision" },
      });
      fireEvent.click(
        screen.getByRole("button", {
          name: action === "send" ? "Send test message" : "Retry next-answer",
        }),
      );
      await waitFor(() => expect(action === "send" ? sendMock : retryMock).toHaveBeenCalledOnce());
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Edit answers" })).toBeEnabled(),
      );
      expect(screen.queryByRole("button", { name: "Save answers" })).not.toBeInTheDocument();
      expect(editMock).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Edit answers" }));
      expect(screen.getByRole("textbox", { name: "Or write your own answer" })).toHaveValue("");
      expect(screen.getByRole("button", { name: "Simple" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    },
  );

  it("switches from an answer edit to another message editor", () => {
    renderView(null, resolvedPayload());
    fireEvent.click(screen.getByRole("button", { name: "Edit answers" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit m-user" }));
    expect(screen.queryByRole("button", { name: "Save answers" })).not.toBeInTheDocument();
    expect(screen.getByText("Editing m-user")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Unrelated composer draft" })).toBeDisabled();
    expect(editMock).not.toHaveBeenCalled();
  });

  it("locks other actions only while the answer save is submitting", async () => {
    let finish!: (value: Awaited<ReturnType<typeof editMessage>>) => void;
    editMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    conversationMock.mockResolvedValueOnce(resolvedPayload() as never);
    renderView(null, resolvedPayload());
    fireEvent.click(screen.getByRole("button", { name: "Edit answers" }));
    fireEvent.click(screen.getByRole("button", { name: "Save answers" }));
    await waitFor(() => expect(editMock).toHaveBeenCalledOnce());
    expect(screen.getByRole("textbox", { name: "Unrelated composer draft" })).toBeDisabled();
    for (const name of [
      "Save answers",
      "Cancel",
      "Send test message",
      "Select Model Two",
      "Retry next-answer",
      "Edit m-user",
    ]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    await act(async () => finish({} as never));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send test message" })).toBeEnabled(),
    );
  });

  it("uses downstream edit confirmation and preserves the revised draft when cancelled", async () => {
    const current = resolvedPayload();
    renderView(null, {
      ...current,
      messages: [
        ...current.messages,
        message("later-user", "user", "Later"),
        message("later-answer", "assistant", "Later reply"),
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit answers" }));
    const draft = screen.getByRole("textbox", { name: "Or write your own answer" });
    fireEvent.change(draft, { target: { value: "Revised answer" } });
    fireEvent.click(screen.getByRole("button", { name: "Save answers" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(editMock).not.toHaveBeenCalled();
    expect(draft).toHaveValue("Revised answer");
    const revised: QuestionResponse = {
      kind: "answers",
      answers: [{ selected: [], custom: "Revised answer" }],
    };
    editMock.mockResolvedValueOnce({} as never);
    conversationMock.mockResolvedValueOnce(resolvedPayload(revised) as never);
    fireEvent.click(screen.getByRole("button", { name: "Save answers" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save and regenerate" }));
    await waitFor(() => expect(editMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText("Later reply")).not.toBeInTheDocument());
  });

  it("refetches structural edit failures and retains draft before allowing retry", async () => {
    editMock.mockRejectedValueOnce(new Error("Offline"));
    conversationMock.mockResolvedValueOnce(resolvedPayload() as never);
    renderView(null, resolvedPayload());
    fireEvent.click(screen.getByRole("button", { name: "Edit answers" }));
    const draft = screen.getByRole("textbox", { name: "Or write your own answer" });
    fireEvent.change(draft, { target: { value: "Keep my revision" } });
    fireEvent.click(screen.getByRole("button", { name: "Save answers" }));
    await waitFor(() => expect(conversationMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: "Save answers" })).toBeEnabled());
    expect(draft).toHaveValue("Keep my revision");
    expect(toast.error).toHaveBeenCalledWith(
      "Could not save your answers. Your draft has been kept.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Simple")).toBeInTheDocument();
    expect(resetUploads).not.toHaveBeenCalled();
  });
});

describe("ChatView question handoff", () => {
  it("hydrates validated questions with live-result parity and rejects unknown versions", () => {
    expect(toActivity(askRow)).toEqual({
      family: "ask",
      callId: "ask-1",
      name: "ask_user",
      status: "complete",
      turnIndex: 1,
      callIndex: 2,
      questions: askQuestions,
    });
    expect(toActivity({ ...askRow, result: { ...askRow.result, v: 2 } })).toMatchObject({
      family: "ask",
      status: "error",
    });
    expect(toActivity({ ...askRow, result: null })).not.toHaveProperty("questions");
  });

  it("seeds replayed question results after the durable snapshot", () => {
    renderView(null, {
      messages: [
        message("m-user", "user", "u1"),
        { ...message("m-answer", "assistant", ""), status: "streaming" as never },
      ],
      toolCalls: [{ ...askRow, status: "running", result: null }],
      pendingChunks: [
        {
          seq: 3,
          kind: "tool",
          delta: JSON.stringify({
            v: 1,
            family: "ask",
            phase: "result",
            callId: "ask-1",
            name: "ask_user",
            result: askRow.result,
          }),
        },
      ],
    });
    expect(streamProbe).toHaveBeenLastCalledWith(
      "m-answer",
      expect.objectContaining({
        lastSeq: 3,
        tools: [
          {
            family: "ask",
            callId: "ask-1",
            name: "ask_user",
            status: "complete",
            turnIndex: 1,
            callIndex: 2,
            questions: askQuestions,
          },
        ],
      }),
      "c1",
      0,
      null,
    );
  });

  it("sends current settings without attachments and preserves unrelated composer draft", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof answerQuestion>>) => void;
    answerMock.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const next = payload(null, {
      toolCalls: [askRow],
      messages: [
        ...basePayload(null).messages,
        message("reply", "user", "Q1: Simple"),
        { ...message("next", "assistant", ""), status: "streaming" as never },
      ],
    });
    conversationMock.mockResolvedValue(next as never);
    renderView(null, { toolCalls: [askRow] });
    fireEvent.change(screen.getByRole("textbox", { name: "Unrelated composer draft" }), {
      target: { value: "Keep my separate draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Select Model Two" }));
    fireEvent.click(screen.getByRole("button", { name: "Simple" }));
    fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
    await waitFor(() =>
      expect(answerMock).toHaveBeenCalledWith({
        data: {
          conversationId: "c1",
          callId: "ask-1",
          response: { kind: "answers", answers: [{ selected: [0], custom: "" }] },
          modelId: "m2",
          // Model Two has no native tool calling; search is still offered.
          searchEnabled: true,
          timeZone: "Europe/Berlin",
        },
      }),
    );
    expect(screen.getByRole("button", { name: "Send answers" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Retry m-answer" })).toBeDisabled();
    await act(async () => resolve({ conversationId: "c1", assistantMessageId: "next" }));
    await waitFor(() =>
      expect(streamProbe).toHaveBeenLastCalledWith("next", expect.any(Object), "c1", 0, null),
    );
    expect(screen.getByRole("textbox", { name: "Unrelated composer draft" })).toHaveValue(
      "Keep my separate draft",
    );
    expect(sendMock).not.toHaveBeenCalled();
    expect(markClaimed).not.toHaveBeenCalled();
    expect(resetUploads).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Send answers" })).not.toBeInTheDocument();
  });

  it("refetches ambiguous failures before restoring controls and keeps the answer draft", async () => {
    answerMock.mockRejectedValueOnce(new Error("Connection lost"));
    let resolve!: (value: Awaited<ReturnType<typeof getConversationWithMessages>>) => void;
    conversationMock.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    renderView(null, { toolCalls: [askRow] });
    fireEvent.change(screen.getByRole("textbox", { name: "Or write your own answer" }), {
      target: { value: "Keep this answer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
    await waitFor(() => expect(conversationMock).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Send answers" })).toBeDisabled();
    await act(async () => resolve(payload(null, { toolCalls: [askRow] }) as never));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send answers" })).toBeEnabled());
    expect(screen.getByRole("textbox", { name: "Or write your own answer" })).toHaveValue(
      "Keep this answer",
    );
    expect(toast.error).toHaveBeenCalledWith(
      "Could not send your answers. Your draft has been kept.",
    );
  });

  it("keeps answers locked after failed recovery until an explicit refresh succeeds", async () => {
    answerMock.mockRejectedValueOnce(new Error("Connection lost"));
    conversationMock.mockRejectedValueOnce(new Error("Still offline"));
    renderView(null, { toolCalls: [askRow] });
    fireEvent.click(screen.getByRole("button", { name: "Simple" }));
    fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
    const refresh = await screen.findByRole("button", { name: "Refresh chat" });
    expect(screen.getByRole("button", { name: "Send answers" })).toBeDisabled();
    conversationMock.mockResolvedValueOnce(payload(null, { toolCalls: [askRow] }) as never);
    fireEvent.click(refresh);
    await waitFor(() => expect(screen.getByRole("button", { name: "Send answers" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Simple" })).toHaveAttribute("aria-pressed", "true");
  });

  it.each(["user", "system", "assistant"] as const)(
    "a later %s message makes the old question read-only",
    (role) => {
      renderView(null, {
        toolCalls: [askRow],
        messages: [...basePayload(null).messages, message("later", role, "later")],
      });
      expect(screen.getByText("Which direction?")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Skip and continue" })).not.toBeInTheDocument();
    },
  );

  it.each(["message.created", "message.status"] as const)(
    "closes stale question controls after cross-tab %s invalidation",
    async (type) => {
      renderView(null, { toolCalls: [askRow] });
      expect(screen.getByRole("button", { name: "Skip and continue" })).toBeEnabled();
      conversationMock.mockResolvedValueOnce(
        payload(null, {
          toolCalls: [askRow],
          messages: [...basePayload(null).messages, message("reply", "user", "An ordinary reply")],
        }) as never,
      );
      await act(async () =>
        FakeEventSource.instances
          .at(-1)!
          .emit("sync", { type, conversationId: "c1", messageId: "reply", status: "complete" }),
      );
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Skip and continue" })).not.toBeInTheDocument(),
      );
      expect(screen.getByText("An ordinary reply")).toBeInTheDocument();
    },
  );

  it("normal composer sends also close the old question", async () => {
    sendMock.mockResolvedValueOnce({} as never);
    conversationMock.mockResolvedValueOnce(
      payload(null, {
        toolCalls: [askRow],
        messages: [...basePayload(null).messages, message("reply", "user", "hello")],
      }) as never,
    );
    renderView(null, { toolCalls: [askRow] });
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Skip and continue" })).not.toBeInTheDocument(),
    );
    expect(answerMock).not.toHaveBeenCalled();
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
          timeZone: "Europe/Berlin",
          attachmentIds: [],
          // Collections are per message, like files: always sent, empty here.
          collectionIds: [],
        },
      }),
    );
    await waitFor(() => expect(screen.getByTestId("search-mode")).toHaveTextContent("on"));
  });
});

describe("ChatView retry", () => {
  it("selects the explicit retry model for subsequent sends only after success", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof retryMessage>>) => void;
    retryMock.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    conversationMock.mockResolvedValue(payload(null) as never);
    sendMock.mockResolvedValueOnce({} as never);
    renderView();

    fireEvent.click(screen.getByRole("button", { name: "Retry m-answer with m2" }));
    await waitFor(() =>
      expect(retryMock).toHaveBeenCalledWith({
        data: {
          conversationId: "c1",
          messageId: "m-answer",
          modelId: "m2",
          timeZone: "Europe/Berlin",
        },
      }),
    );
    expect(screen.getByTestId("composer-model")).toHaveTextContent("m1");

    await act(async () => resolve({} as never));
    await waitFor(() => expect(screen.getByTestId("composer-model")).toHaveTextContent("m2"));
    // Model Two has no native tool calling; search stays on regardless.
    expect(screen.getByTestId("search-mode")).toHaveTextContent("on");

    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith({
        data: {
          conversationId: "c1",
          modelId: "m2",
          content: "hello",
          searchEnabled: true,
          timeZone: "Europe/Berlin",
          attachmentIds: [],
          // Collections are per message, like files: always sent, empty here.
          collectionIds: [],
        },
      }),
    );
  });

  it("keeps the composer selection when retrying the original model", async () => {
    retryMock.mockResolvedValueOnce({} as never);
    conversationMock.mockResolvedValue(payload(null) as never);
    renderView();

    fireEvent.click(screen.getByRole("button", { name: "Select Model Two" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry m-answer" }));
    });
    await waitFor(() => expect(conversationMock).toHaveBeenCalled());

    expect(retryMock).toHaveBeenCalledWith({
      data: { conversationId: "c1", messageId: "m-answer", timeZone: "Europe/Berlin" },
    });
    expect(screen.getByTestId("composer-model")).toHaveTextContent("m2");
  });

  it("keeps the composer selection when the explicit retry is rejected", async () => {
    retryMock.mockRejectedValueOnce(new Error("Model unavailable"));
    renderView();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry m-answer with m2" }));
    });

    expect(retryMock).toHaveBeenCalledTimes(1);
    expect(conversationMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("composer-model")).toHaveTextContent("m1");
  });

  it("keeps the composer selection when an earlier-response retry is cancelled", async () => {
    renderView(null, {
      messages: [
        ...basePayload(null).messages,
        message("m-user-2", "user", "u2"),
        message("m-answer-2", "assistant", "a2"),
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry m-answer with m2" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(retryMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("composer-model")).toHaveTextContent("m1");
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

it("hydrates document source activities only from an explicit knowledge envelope", () => {
  const source = {
    kind: "document",
    index: 1,
    title: "Contract",
    snippet: "Term",
    read: true,
    collectionId: "c",
    documentId: "d",
    versionId: "v",
    startOffset: 0,
    endOffset: 4,
    page: null,
    headingPath: "",
  };
  const result = {
    family: "knowledge",
    ok: true,
    summary: {
      targets: [],
      documentsListed: 0,
      passagesReturned: 1,
      remainingOps: 63,
      coverage: "Excerpt only",
    },
    sources: [source],
  };
  const row = {
    id: "read",
    toolName: "read_document",
    turnIndex: 0,
    callIndex: 0,
    textOffset: 4,
    status: "complete" as const,
    arguments: {},
    result,
    error: null,
  };
  expect(toActivity(row)).toMatchObject({
    family: "knowledge",
    status: "complete",
    textOffset: 4,
    sources: [source],
  });
  expect(toActivity({ ...row, result: { ...result, family: undefined } })).toMatchObject({
    family: "knowledge",
    status: "error",
  });
  expect(toActivity({ ...row, result: { ...result, family: undefined } })).not.toHaveProperty(
    "sources",
  );
});

describe("ChatView knowledge placement", () => {
  it("passes document sources forward for inherited citations", () => {
    const source = {
      kind: "document" as const,
      index: 1,
      title: "Contract",
      snippet: "",
      read: true,
      collectionId: "c",
      documentId: "d",
      versionId: "v",
      startOffset: 0,
      endOffset: 10,
      page: null,
      headingPath: "",
    };
    renderView(null, {
      messages: [
        message("m-user", "user", "u1"),
        message("m-answer", "assistant", "first"),
        message("m-later", "assistant", "inherited [^1]"),
      ],
      toolCalls: [
        {
          id: "knowledge-call",
          messageId: "m-answer",
          toolName: "knowledge_context",
          status: "complete",
          turnIndex: 0,
          callIndex: 0,
          textOffset: 0,
          result: {
            v: 1,
            family: "knowledge",
            ok: true,
            targets: [],
            summary: {
              targets: [],
              documentsListed: 0,
              passagesReturned: 1,
              remainingOps: 63,
              coverage: "Excerpt only",
            },
            sources: [source],
          },
          error: null,
        } as never,
      ],
    });
    expect(
      JSON.parse(
        document
          .querySelector('[data-message-id="m-later"]')!
          .getAttribute("data-inherited-sources")!,
      ),
    ).toEqual([source]);
  });

  it("hands a turn's collections to the question that added them, not the answer", () => {
    renderView(null, {
      generations: [
        {
          messageId: "m-answer",
          agent: null,
          collectionIds: ["c-contracts"],
          knowledgeMode: "context",
        },
      ],
    });
    const user = document.querySelector('[data-message-id="m-user"]')!;
    const answer = document.querySelector('[data-message-id="m-answer"]')!;
    expect(user).toHaveAttribute("data-collection-ids", "c-contracts");
    expect(answer).not.toHaveAttribute("data-collection-ids");
  });
});
