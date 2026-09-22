import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PROTOCOL_VERSION, type BridgeReply } from "@chat/desktop-rpc";
import type { ConversationMode } from "../schema.ts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { AskUserBlock } from "./ask-user-block.tsx";
import type { DisplayMessage } from "./message-list.tsx";
import { useSync } from "~/modules/sync/client/use-sync.ts";
import { FakeEventSource } from "../../../../tests/fixtures/event-source.ts";
import { ChatView, sendReservedWorkspaceTurn, toActivity } from "./chat-view.tsx";
import {
  abortWorkTurn,
  answerQuestion,
  branchConversation,
  getConversationWithMessages,
  editMessage,
  getWorkTurnReservation,
  reserveWorkTurn,
  retryMessage,
  sendMessage,
  stopGeneration,
} from "../server/functions.ts";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { DetailPanelProvider, DetailPanelRail } from "~/ui/detail-panel.tsx";
import { AppMotionProvider } from "~/ui/motion.tsx";
import { EMPTY_AGENT_DRAFT, type AgentDraft } from "~/modules/agents/draft-schema.ts";
import {
  getAgentDraft,
  patchAgentDraft,
  saveAgentDraft,
} from "~/modules/agents/server/draft-functions.ts";
import { AgentDraftActivityBlock } from "./agent-draft-activity-block.tsx";
import { applyToolChunk, type ToolActivity } from "../client/use-message-stream.ts";
import { formatQuestionResponse, type QuestionResponse } from "~/modules/tools/ask-user-schema.ts";
import type { ConversationDocument } from "~/modules/documents/schema.ts";
import {
  getDocument,
  saveDocument,
  toggleDocumentTask,
} from "~/modules/documents/server/document-functions.ts";
import { DocumentActivityBlock } from "./document-activity-block.tsx";
import type { WorkspaceImports } from "~/modules/desktop/client/use-workspace-imports.ts";

const { navigate, markClaimed, resetUploads, seedUploads, streamProbe } = vi.hoisted(() => ({
  navigate: vi.fn(),
  markClaimed: vi.fn(),
  resetUploads: vi.fn(),
  seedUploads: vi.fn(),
  streamProbe: vi.fn(),
}));

const liveDraft = vi.hoisted(() => ({
  tools: [] as ToolActivity[],
  status: "complete" as "complete" | "streaming",
}));
vi.mock("~/modules/agents/server/draft-functions.ts", () => ({
  getAgentDraft: vi.fn(),
  patchAgentDraft: vi.fn(),
  saveAgentDraft: vi.fn(),
  reloadAgentDraft: vi.fn(),
}));
vi.mock("~/modules/documents/server/document-functions.ts", () => ({
  getDocument: vi.fn(),
  saveDocument: vi.fn(),
  toggleDocumentTask: vi.fn(),
  listDocuments: vi.fn(),
}));
vi.mock("~/modules/skills/ui/text-editor.tsx", () => ({
  default: ({
    value,
    onChange,
    label,
  }: {
    value: string;
    onChange: (value: string) => void;
    label: string;
  }) => (
    <textarea aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

vi.mock("../server/functions.ts", () => ({
  abortWorkTurn: vi.fn(),
  activateWorkTurn: vi.fn(),
  getConversationWithMessages: vi.fn(),
  getWorkTurnReservation: vi.fn(),
  listConversations: vi.fn(),
  reserveWorkTurn: vi.fn(),
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
  createKnowledgeCollection: vi.fn(),
  updateKnowledgeCollection: vi.fn(),
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
  useBlocker: vi.fn(),
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
          data-steers={
            Array.isArray(message.steers)
              ? JSON.stringify(message.steers.map((steer: { content: string }) => steer.content))
              : undefined
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
            ) : activity.family === "agent-draft" ? (
              <AgentDraftActivityBlock key={activity.callId} activity={activity} />
            ) : activity.family === "document" ? (
              <DocumentActivityBlock key={activity.callId} activity={activity} />
            ) : null,
          )}
          {(message.compactionActivities as ReadonlyArray<{ summary?: string }> | undefined)?.map(
            (activity, index) => (
              <output key={index} data-testid="compaction-activity">
                {`${String(message.id)}: ${activity.summary ?? "running"}`}
              </output>
            ),
          )}
          {message.editState ? (
            <>
              <output>Editing {String(message.id)}</output>
              <button
                type="button"
                onClick={() =>
                  (message.editState as NonNullable<DisplayMessage["editState"]>).onSave(
                    "Changed user message",
                  )
                }
              >
                Save message edit
              </button>
              <button
                type="button"
                aria-label={`Offer research in edit ${String(message.id)}`}
                onClick={() =>
                  (
                    message.editState as {
                      onResearchEnabledChange?: (enabled: boolean) => void;
                    }
                  ).onResearchEnabledChange?.(true)
                }
              >
                Offer research
              </button>
              <button
                type="button"
                aria-label={`Pick skill in edit ${String(message.id)}`}
                onClick={() =>
                  (
                    message.editState as {
                      skills?: { onChange: (ids: string[]) => void };
                    }
                  ).skills?.onChange(["s-picked"])
                }
              >
                Pick skill
              </button>
              <output data-testid={`edit-selection-${String(message.id)}`}>
                {(
                  message.editState as { skills?: { selectedIds: readonly string[] } }
                ).skills?.selectedIds.join(",") ?? ""}
                |
                {(
                  message.editState as {
                    context?: { sendFields: { collectionIds: readonly string[] } };
                  }
                ).context?.sendFields.collectionIds.join(",") ?? ""}
              </output>
            </>
          ) : null}
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
    onStop,
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
    onStop?: () => void;
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
      <button type="button" disabled={controlsDisabled} onClick={() => onSearchEnabledChange(true)}>
        Enable search
      </button>
      {onStop ? (
        <button type="button" onClick={onStop}>
          Stop test generation
        </button>
      ) : null}
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          void onSend("hello", []).catch(() => {});
        }}
      >
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
      tools: liveDraft.tools,
      compactions: [],
      steers: [],
      lastSeq: 0,
      status: liveDraft.status,
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
    seed: seedUploads,
    submit: (send: (ids: ReadonlyArray<string>) => unknown) => send([]),
    cancelQueue: vi.fn(),
    markClaimed,
    reset: resetUploads,
    dismissNotice: vi.fn(),
  }),
}));

const abortReservationMock = vi.mocked(abortWorkTurn);
const branchMock = vi.mocked(branchConversation);
const conversationMock = vi.mocked(getConversationWithMessages);
const reservationStatusMock = vi.mocked(getWorkTurnReservation);
const reserveMock = vi.mocked(reserveWorkTurn);
const sendMock = vi.mocked(sendMessage);
const retryMock = vi.mocked(retryMessage);

const BASE = new Date("2026-03-01T12:00:00Z");

const message = (id: string, role: "user" | "assistant" | "system", content: string) => ({
  id,
  conversationId: "01990f4e-6650-7a33-a768-611e2e4bf4c7",
  role,
  status: "complete" as "complete" | "streaming",
  content,
  reasoning: "",
  modelId: "m1",
  usage: null,
  error: null,
  createdAt: BASE,
  completedAt: BASE,
  editedAt: null,
  questionResponse: null as unknown,
  steeredIntoMessageId: null as string | null,
  steerTextOffset: null as number | null,
  steerTurnIndex: null as number | null,
});

type Payload = ReturnType<typeof basePayload>;

const basePayload = (branchedFrom: { conversationId: string; title: string | null } | null) => ({
  conversation: {
    id: "01990f4e-6650-7a33-a768-611e2e4bf4c7",
    userId: "u1",
    title: "Current chat",
    mode: "chat" as ConversationMode,
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
  agent: null as {
    id: string;
    name: string;
    icon: string;
    collectionIds: ReadonlyArray<string>;
    skillIds: ReadonlyArray<string>;
    searchEnabled: boolean;
    available: boolean;
  } | null,
  agentDrafts: [] as ReadonlyArray<{ id: string; name: string; messageId: string }>,
  documents: [] as ReadonlyArray<{ id: string; title: string }>,
  collectionIds: [] as string[],
  generations: [] as Array<{
    messageId: string;
    agent: { name: string; icon: string } | null;
    collectionIds: ReadonlyArray<string>;
    knowledgeMode: "none" | "context" | "retrieval";
    skills?: ReadonlyArray<{ id: string; name: string }>;
  }>,
  toolCalls: [] as Array<Parameters<typeof toActivity>[0] & { messageId: string }>,
  attachments: [],
  queue: [],
  queueState: null,
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
    // The payload is seeded, not fetched. The server functions are mocks.
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(
    ["conversation", "01990f4e-6650-7a33-a768-611e2e4bf4c7"],
    payload(branchedFrom, overrides),
  );
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
  client.setQueryData(["skills"], []);
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <SyncProbe />
        <AppMotionProvider>
          <ConfirmProvider>
            <DetailPanelProvider>
              <Suspense fallback={null}>
                <ChatView conversationId="01990f4e-6650-7a33-a768-611e2e4bf4c7" />
              </Suspense>
              <DetailPanelRail />
            </DetailPanelProvider>
          </ConfirmProvider>
        </AppMotionProvider>
      </QueryClientProvider>,
    ),
  };
};

const desktopRequest = vi.fn<(tag: string, payload: unknown) => Promise<BridgeReply>>();
beforeEach(() => {
  vi.clearAllMocks();
  desktopRequest.mockReset();
  desktopRequest.mockImplementation(async (tag) =>
    tag === "executionSession"
      ? {
          ok: true,
          value: { id: "executor", machineId: "machine", machineName: "Test Mac" },
        }
      : {
          ok: true,
          value: {
            folders: [],
            workspace: { path: "/workspaces/01990f4e-6650-7a33-a768-611e2e4bf4c7" },
            sandbox: { kind: "ready" },
          },
        },
  );
  vi.stubGlobal("__chatDesktop", {
    protocolVersion: PROTOCOL_VERSION,
    request: desktopRequest,
    stageDroppedFile: async () => null,
  });
  liveDraft.tools = [];
  liveDraft.status = "complete";
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => vi.unstubAllGlobals());

const stagedImports = () => {
  const promote = vi.fn(async (reservationId: string) => ({
    reservationId,
    files: [{ stagedName: "report.pdf", finalName: "report.pdf", bytes: 12 }],
  }));
  const commit = vi.fn(async () => {});
  const rollback = vi.fn(async () => {});
  const imports: WorkspaceImports = {
    items: [],
    fileNames: ["report.pdf"],
    importing: false,
    hasError: false,
    isFull: false,
    notice: null,
    queued: false,
    submissionId: "550e8400-e29b-41d4-a716-446655440000",
    addFiles: vi.fn(),
    remove: vi.fn(),
    submit: vi.fn(),
    cancelQueue: vi.fn(),
    promote,
    commit,
    rollback,
    markClaimed: vi.fn(),
    reset: vi.fn(),
    dismissNotice: vi.fn(),
  };
  return { imports, commit, rollback };
};

describe("reserved workspace sends", () => {
  it("aborts and rolls back after a confirmed failed activation retry", async () => {
    reserveMock.mockResolvedValue({} as never);
    reservationStatusMock.mockResolvedValue({
      conversationId: "conversation",
      status: "reserved",
      assistantMessageId: null,
    } as never);
    abortReservationMock.mockResolvedValue(undefined as never);
    const activationError = new Error("Activation rejected");
    const activate = vi.fn().mockRejectedValue(activationError);
    const staged = stagedImports();

    await expect(
      sendReservedWorkspaceTurn({
        conversation: { kind: "existing", id: "conversation" },
        imports: staged.imports,
        activate,
      }),
    ).rejects.toBe(activationError);

    expect(activate).toHaveBeenCalledTimes(2);
    expect(reservationStatusMock).toHaveBeenCalledTimes(2);
    expect(abortReservationMock).toHaveBeenCalledTimes(1);
    expect(staged.rollback).toHaveBeenCalledTimes(1);
    expect(staged.commit).not.toHaveBeenCalled();
  });

  it("retains promotion evidence when the activation retry is ambiguous", async () => {
    reserveMock.mockResolvedValue({} as never);
    reservationStatusMock
      .mockResolvedValueOnce({
        conversationId: "conversation",
        status: "reserved",
        assistantMessageId: null,
      } as never)
      .mockRejectedValueOnce(new Error("Server unreachable"));
    const activationError = new Error("Connection lost");
    const activate = vi.fn().mockRejectedValue(activationError);
    const staged = stagedImports();

    await expect(
      sendReservedWorkspaceTurn({
        conversation: { kind: "existing", id: "conversation" },
        imports: staged.imports,
        activate,
      }),
    ).rejects.toBe(activationError);

    expect(activate).toHaveBeenCalledTimes(2);
    expect(abortReservationMock).not.toHaveBeenCalled();
    expect(staged.rollback).not.toHaveBeenCalled();
    expect(staged.commit).not.toHaveBeenCalled();
  });
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

  it("accepts live research progress after loading a running row without progress", () => {
    const initial = toActivity({
      ...row,
      toolName: "deep_research",
      status: "running",
      result: null,
    });
    const progress = {
      runId: "run-1",
      phase: "researching",
      usageComplete: true,
      limitations: [],
      tasks: [],
    };
    const tools = applyToolChunk(
      [initial],
      JSON.stringify({
        v: 1,
        family: "research",
        name: "deep_research",
        callId: row.id,
        runId: progress.runId,
        phase: "progress",
        progress,
      }),
    );
    expect(initial.status).toBe("running");
    expect(tools[0]).toMatchObject({ status: "running", runId: "run-1", progress });
    const completed = applyToolChunk(
      tools,
      JSON.stringify({
        v: 1,
        family: "research",
        name: "deep_research",
        callId: row.id,
        runId: progress.runId,
        phase: "result",
        progress: { ...progress, phase: "complete" },
      }),
    );
    expect(completed[0]).toMatchObject({ status: "complete", runId: "run-1" });
  });

  it.each(["complete", "error"] as const)(
    "keeps %s research without progress terminal",
    (status) => {
      expect(toActivity({ ...row, toolName: "deep_research", status, result: null }).status).toBe(
        "error",
      );
    },
  );

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

  it("hydrates a refused save with its fixed reason and nothing else", () => {
    expect(
      toActivity({
        ...row,
        toolName: "save_memory",
        status: "error",
        result: { outcome: "rejected", reason: "sensitive", message: "private text" },
      }),
    ).toEqual({
      family: "memory",
      callId: "tool-1",
      name: "save_memory",
      turnIndex: 1,
      callIndex: 2,
      status: "error",
      outcome: "rejected",
      reason: "sensitive",
    });
    expect(
      toActivity({
        ...row,
        toolName: "save_memory",
        status: "error",
        result: { outcome: "rejected", reason: "not a real reason" },
      }),
    ).not.toHaveProperty("reason");
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

it("guards Work initiation while folder IPC is unresolved, then enables ready-empty actions", async () => {
  let resolve!: (reply: BridgeReply) => void;
  const pending = new Promise<BridgeReply>((done) => {
    resolve = done;
  });
  desktopRequest.mockReturnValue(pending);
  const data = basePayload(null);
  renderView(null, { conversation: { ...data.conversation, mode: "work" }, toolCalls: [askRow] });
  expect(screen.getByRole("button", { name: "Retry m-answer" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Edit m-user" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Send answers" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Branch off m-answer" })).toBeEnabled();
  // The composer test double bypasses UI gating, so this exercises the view's handler.
  fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      "Wait for the folder check before continuing this work chat.",
    ),
  );
  expect(sendMock).not.toHaveBeenCalled();
  expect(retryMock).not.toHaveBeenCalled();
  expect(editMessage).not.toHaveBeenCalled();
  expect(answerQuestion).not.toHaveBeenCalled();
  expect(desktopRequest).not.toHaveBeenCalledWith("executionSession", expect.anything());
  await act(async () =>
    resolve({
      ok: true,
      value: {
        folders: [],
        workspace: { path: "/workspaces/01990f4e-6650-7a33-a768-611e2e4bf4c7" },
        sandbox: { kind: "ready" },
      },
    }),
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "Retry m-answer" })).toBeEnabled());
  expect(screen.getByRole("button", { name: "Edit m-user" })).toBeEnabled();
});

it("draws a steer inside the answer it changed, and names it before a retry removes it", async () => {
  renderView(null, {
    messages: [
      message("m-user", "user", "u1"),
      {
        ...message("m-steer", "user", "make it about dogs"),
        steeredIntoMessageId: "m-answer",
        steerTextOffset: 1,
        steerTurnIndex: 0,
      },
      message("m-answer", "assistant", "a1"),
    ],
  });
  // Never a transcript row of its own: it belongs to the answer.
  expect(document.querySelector('[data-message-id="m-steer"]')).toBeNull();
  expect(document.querySelector('[data-message-id="m-answer"]')).toHaveAttribute(
    "data-steers",
    JSON.stringify(["make it about dogs"]),
  );
  // Retrying the last answer normally asks nothing; a steer is the person's
  // own words, so losing it is named first.
  fireEvent.click(screen.getByRole("button", { name: "Retry m-answer" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(
    within(dialog).getByText("The message you steered into it will be removed too."),
  ).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(retryMock).not.toHaveBeenCalled();
});

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
        conversationId: "01990f4e-6650-7a33-a768-611e2e4bf4c7",
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
      conversationId: "01990f4e-6650-7a33-a768-611e2e4bf4c7",
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
          conversationId: "01990f4e-6650-7a33-a768-611e2e4bf4c7",
          messageId: "structured-user",
          modelId: "m1",
          searchEnabled: false,
          researchEnabled: false,
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
    // An open editor locks nothing: the composer stays usable and the other
    // messages keep their own Edit buttons, so one click switches between them.
    expect(screen.getByRole("textbox", { name: "Unrelated composer draft" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit m-user" })).not.toBeDisabled();
    expect(editMock).not.toHaveBeenCalled();
  });

  it("switches between ordinary editors and reseeds the second message's files", () => {
    const two = payload(null, {
      messages: [
        message("m-user", "user", "u1"),
        message("m-answer", "assistant", "a1"),
        message("m-user-2", "user", "u2"),
        message("m-answer-2", "assistant", "a2"),
      ],
    });
    renderView(null, two);
    fireEvent.click(screen.getByRole("button", { name: "Edit m-user" }));
    expect(screen.getByText("Editing m-user")).toBeInTheDocument();
    seedUploads.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Edit m-user-2" }));
    expect(screen.getByText("Editing m-user-2")).toBeInTheDocument();
    expect(screen.queryByText("Editing m-user")).not.toBeInTheDocument();
    // `seed` drops the abandoned editor's uploads before taking the new ones.
    expect(seedUploads).toHaveBeenCalledTimes(1);
    expect(editMock).not.toHaveBeenCalled();
  });

  // The report was "the skills and collections are not there anymore": the server
  // kept them, the editor just never received them.
  it("seeds the editor with the message's own skills and standalone collections", () => {
    const withSelection = payload(null, {
      agent: {
        id: "a1",
        name: "Agent",
        icon: "robot",
        collectionIds: ["c-agent"],
        skillIds: [],
        searchEnabled: true,
        available: true,
      },
      generations: [
        {
          messageId: "m-answer",
          agent: null,
          collectionIds: ["c-agent", "c-standalone"],
          knowledgeMode: "context" as const,
          skills: [{ id: "s1", name: "Brand" }],
        },
      ],
    });
    renderView(null, withSelection);
    fireEvent.click(screen.getByRole("button", { name: "Edit m-user" }));
    // The agent's own collection stays out: reseeding it as standalone would
    // rewrite what the turn actually ran with.
    expect(screen.getByTestId("edit-selection-m-user")).toHaveTextContent("s1|c-standalone");
  });

  it("ends the edit when the composer sends, releasing its uploads", async () => {
    renderView(null, resolvedPayload());
    fireEvent.click(screen.getByRole("button", { name: "Edit m-user" }));
    expect(screen.getByText("Editing m-user")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
    await waitFor(() => expect(sendMock).toHaveBeenCalled());
    expect(screen.queryByText("Editing m-user")).not.toBeInTheDocument();
    expect(resetUploads).toHaveBeenCalled();
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
    expect(toast.error).toHaveBeenCalledWith("Could not save your answers.");
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
      "01990f4e-6650-7a33-a768-611e2e4bf4c7",
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
          conversationId: "01990f4e-6650-7a33-a768-611e2e4bf4c7",
          callId: "ask-1",
          response: { kind: "answers", answers: [{ selected: [0], custom: "" }] },
          modelId: "m2",
          // Model Two has no native tool calling; search is still offered.
          searchEnabled: true,
          // Answering a clarification is its own submission and has no toggle.
          researchEnabled: false,
          timeZone: "Europe/Berlin",
        },
      }),
    );
    expect(screen.getByRole("button", { name: "Send answers" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Retry m-answer" })).toBeDisabled();
    await act(async () =>
      resolve({
        conversationId: "01990f4e-6650-7a33-a768-611e2e4bf4c7",
        assistantMessageId: "next",
      }),
    );
    await waitFor(() =>
      expect(streamProbe).toHaveBeenLastCalledWith(
        "next",
        expect.any(Object),
        "01990f4e-6650-7a33-a768-611e2e4bf4c7",
        0,
        null,
      ),
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
    expect(toast.error).toHaveBeenCalledWith("Could not send your answers.", {
      description: "Connection lost.",
    });
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
        FakeEventSource.instances.at(-1)!.emit("sync", {
          type,
          conversationId: "01990f4e-6650-7a33-a768-611e2e4bf4c7",
          messageId: "reply",
          status: "complete",
        }),
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

  it("rests on the installed agent's search default and returns to it after a send", async () => {
    const quiet = payload(null, {
      agent: {
        id: "a1",
        name: "Quiet agent",
        icon: "robot",
        collectionIds: [],
        skillIds: [],
        searchEnabled: false,
        available: true,
      },
    });
    conversationMock.mockResolvedValue(quiet as never);
    sendMock.mockResolvedValue({} as never);
    renderView(null, quiet);
    expect(screen.getByTestId("search-mode")).toHaveTextContent("off");
    fireEvent.click(screen.getByRole("button", { name: "Enable search" }));
    expect(screen.getByTestId("search-mode")).toHaveTextContent("on");
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ searchEnabled: true }) }),
      ),
    );
    await waitFor(() => expect(screen.getByTestId("search-mode")).toHaveTextContent("off"));
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
          conversation: {
            kind: "existing",
            id: "01990f4e-6650-7a33-a768-611e2e4bf4c7",
          },
          modelId: "m1",
          content: "hello",
          searchEnabled: false,
          timeZone: "Europe/Berlin",
          attachmentIds: [],
          // Collections are per message, like files: always sent, empty here.
          collectionIds: [],
          skillIds: [],
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
          conversationId: "01990f4e-6650-7a33-a768-611e2e4bf4c7",
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
          conversation: {
            kind: "existing",
            id: "01990f4e-6650-7a33-a768-611e2e4bf4c7",
          },
          modelId: "m2",
          content: "hello",
          searchEnabled: true,
          timeZone: "Europe/Berlin",
          attachmentIds: [],
          // Collections are per message, like files: always sent, empty here.
          collectionIds: [],
          skillIds: [],
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
      data: {
        conversationId: "01990f4e-6650-7a33-a768-611e2e4bf4c7",
        messageId: "m-answer",
        timeZone: "Europe/Berlin",
      },
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

const draftReference = (
  conversationId = "01990f4e-6650-7a33-a768-611e2e4bf4c7",
  draftId = "d1",
): Payload["toolCalls"][number] => ({
  id: "draft-call",
  messageId: "m-answer",
  toolName: "draft_agent",
  arguments: {},
  result: { outcome: "drafted", draftId, draftConversationId: conversationId, revision: 1 },
  status: "complete",
  turnIndex: 0,
  callIndex: 0,
  error: null,
});
const draftWriteGate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

describe("ChatView agent drafts", () => {
  let current: AgentDraft;
  beforeEach(() => {
    for (const rpc of [sendMock, retryMock, branchMock, editMock, answerMock, conversationMock])
      rpc.mockReset();
    current = {
      id: "d1",
      conversationId: "01990f4e-6650-7a33-a768-611e2e4bf4c7",
      kind: "agent",
      settings: { ...EMPTY_AGENT_DRAFT, name: "Writer" },
      revision: 1,
      targetId: null,
      targetRevision: null,
      savedDraftRevision: null,
      createdAt: BASE.toISOString(),
      updatedAt: BASE.toISOString(),
    };
    vi.mocked(getAgentDraft)
      .mockReset()
      .mockImplementation(async () => current);
    vi.mocked(patchAgentDraft)
      .mockReset()
      .mockImplementation(async ({ data }) => {
        current = {
          ...current,
          revision: current.revision + 1,
          settings: { ...current.settings, ...data.changes },
        };
        return { outcome: "updated", draft: current };
      });
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
  });

  it("discovers a live tool-created draft without a loader flag and opens it", async () => {
    const { client, container } = renderView();
    expect(getAgentDraft).not.toHaveBeenCalled();
    liveDraft.tools = [toActivity(draftReference())];
    act(() =>
      client.setQueryData(
        ["conversation", "01990f4e-6650-7a33-a768-611e2e4bf4c7"],
        payload(null, {
          messages: [
            message("m-user", "user", "u1"),
            { ...message("m-answer", "assistant", ""), status: "streaming" },
          ],
        }),
      ),
    );
    const widget = await screen.findByRole("button", { name: "Open agent draft: Writer" });
    expect(container.querySelector('[data-message-id="m-answer"]')).toContainElement(widget);
    // Created by the answer being watched, so its panel opens without a click.
    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue("Writer");
    expect(getAgentDraft).toHaveBeenCalledWith({ data: { draftId: "d1" } });
  });

  it("discovers a draft from sync-refreshed loader metadata and places it in its answer", async () => {
    const { container } = renderView();
    expect(getAgentDraft).not.toHaveBeenCalled();
    conversationMock.mockResolvedValueOnce(
      payload(null, {
        agentDrafts: [{ id: "d1", name: "Writer", messageId: "m-answer" }],
      }) as never,
    );
    act(() =>
      FakeEventSource.instances.at(-1)!.emit("sync", {
        type: "draft.changed",
        kind: "agent",
        conversationId: "01990f4e-6650-7a33-a768-611e2e4bf4c7",
        draftId: "d1",
      }),
    );
    const widget = await screen.findByRole("button", { name: "Open agent draft: Writer" });
    expect(container.querySelector('[data-message-id="m-answer"]')).toContainElement(widget);
    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
  });

  it("names the draft a retry deletes and drops its editor once it is gone", async () => {
    const withDraft = {
      toolCalls: [draftReference()],
      agentDrafts: [{ id: "d1", name: "Writer", messageId: "m-answer" }],
    };
    renderView(null, withDraft);
    fireEvent.click(await screen.findByRole("button", { name: "Open agent draft: Writer" }));
    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue("Writer");
    retryMock.mockResolvedValueOnce({} as never);
    conversationMock.mockResolvedValueOnce(payload(null) as never);
    fireEvent.click(screen.getByRole("button", { name: "Retry m-answer" }));
    // The last answer normally retries without asking; losing a draft asks.
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("The agent draft “Writer” will also be deleted.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(retryMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Open agent draft/ })).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
  });

  it("keeps copied references historical even after the branch gets its own draft", async () => {
    const { client, container } = renderView(
      { conversationId: "original", title: "Original" },
      { toolCalls: [draftReference("original", "other-draft")] },
    );
    expect(screen.getByText("From another chat")).toBeVisible();
    expect(getAgentDraft).not.toHaveBeenCalled();
    act(() =>
      client.setQueryData(
        ["conversation", "01990f4e-6650-7a33-a768-611e2e4bf4c7"],
        payload(null, {
          toolCalls: [draftReference("original", "other-draft")],
          agentDrafts: [{ id: "d1", name: "Writer", messageId: "m-answer" }],
        }),
      ),
    );
    const widget = await screen.findByRole("button", { name: "Open agent draft: Writer" });
    expect(screen.getAllByRole("button", { name: /Open agent draft/ })).toHaveLength(1);
    expect(container.querySelector('[data-message-id="m-answer"]')).toContainElement(widget);
    expect(screen.getByText("From another chat")).toBeVisible();
    expect(getAgentDraft).not.toHaveBeenCalledWith({ data: { conversationId: "original" } });
  });

  it.each(["send", "retry", "branch", "edit", "answer", "answer edit"] as const)(
    "flushes local settings before %s reaches its RPC",
    async (action) => {
      const start =
        action === "answer edit"
          ? resolvedPayload()
          : payload(null, action === "answer" ? { toolCalls: [askRow] } : {});
      // Opened by an earlier answer, so no rewind here deletes it.
      const withDraft = {
        ...start,
        agentDrafts: [{ id: "d1", name: "Writer", messageId: "m-earlier" }],
      };
      renderView(null, withDraft);
      conversationMock.mockResolvedValue(withDraft as never);
      sendMock.mockResolvedValueOnce({} as never);
      retryMock.mockResolvedValueOnce({} as never);
      branchMock.mockResolvedValueOnce({ conversationId: "branch" } as never);
      editMock.mockResolvedValueOnce({} as never);
      answerMock.mockResolvedValueOnce({} as never);
      fireEvent.click(await screen.findByRole("button", { name: "Open agent draft: Writer" }));
      const blocked = draftWriteGate();
      vi.mocked(patchAgentDraft).mockImplementationOnce(async ({ data }) => {
        await blocked.promise;
        current = { ...current, revision: 2, settings: { ...current.settings, ...data.changes } };
        return { outcome: "updated", draft: current };
      });
      fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
        target: { value: "Reviewed settings" },
      });
      const rpc =
        action === "send"
          ? sendMock
          : action === "retry"
            ? retryMock
            : action === "branch"
              ? branchMock
              : action === "answer"
                ? answerMock
                : editMock;
      if (action === "edit") fireEvent.click(screen.getByRole("button", { name: "Edit m-user" }));
      if (action === "answer edit")
        fireEvent.click(screen.getByRole("button", { name: "Edit answers" }));
      const label = {
        send: "Send test message",
        retry: "Retry m-answer",
        branch: "Branch off m-answer",
        edit: "Save message edit",
        answer: "Skip and continue",
        "answer edit": "Save answers",
      }[action];
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() => expect(patchAgentDraft).toHaveBeenCalledTimes(1));
      expect(rpc).not.toHaveBeenCalled();
      await act(async () => blocked.release());
      await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
      expect(current.settings.name).toBe("Reviewed settings");
      expect(saveAgentDraft).not.toHaveBeenCalled();
    },
  );

  it("blocks send when persistence fails, without discarding local settings", async () => {
    renderView(null, { agentDrafts: [{ id: "d1", name: "Writer", messageId: "m-answer" }] });
    fireEvent.click(await screen.findByRole("button", { name: "Open agent draft: Writer" }));
    vi.mocked(patchAgentDraft).mockRejectedValue(new Error("Offline"));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Keep this" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
    expect(await screen.findByText("Offline")).toBeVisible();
    expect(sendMock).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Keep this");
  });

  it("never waits for a pending draft autosave before stopping generation", async () => {
    liveDraft.status = "streaming";
    renderView(null, {
      agentDrafts: [{ id: "d1", name: "Writer", messageId: "m-answer" }],
      messages: [
        message("m-user", "user", "u1"),
        { ...message("m-answer", "assistant", ""), status: "streaming" },
      ],
    });
    fireEvent.click(await screen.findByRole("button", { name: "Open agent draft: Writer" }));
    const blocked = draftWriteGate();
    vi.mocked(patchAgentDraft).mockImplementationOnce(async ({ data }) => {
      await blocked.promise;
      current = { ...current, revision: 2, settings: { ...current.settings, ...data.changes } };
      return { outcome: "updated", draft: current };
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Still persisting" },
    });
    await waitFor(() => expect(patchAgentDraft).toHaveBeenCalledTimes(1));
    vi.mocked(stopGeneration).mockResolvedValueOnce({ stopped: true });
    fireEvent.click(screen.getByRole("button", { name: "Stop test generation" }));
    await waitFor(() => expect(stopGeneration).toHaveBeenCalledTimes(1));
    expect(current.settings.name).toBe("Writer");
    await act(async () => blocked.release());
    await waitFor(() => expect(current.settings.name).toBe("Still persisting"));
  });
});

const documentReference = (
  conversationId = "01990f4e-6650-7a33-a768-611e2e4bf4c7",
  documentId = "document-1",
): Payload["toolCalls"][number] => ({
  id: "document-call",
  messageId: "m-answer",
  toolName: "create_document",
  arguments: {},
  result: {
    outcome: "created",
    documentId,
    documentConversationId: conversationId,
    title: "Trip plan",
    revision: 1,
  },
  status: "complete",
  turnIndex: 0,
  callIndex: 0,
  error: null,
});

describe("ChatView documents", () => {
  let current: ConversationDocument;
  beforeEach(() => {
    for (const rpc of [sendMock, retryMock, branchMock, editMock, answerMock, conversationMock])
      rpc.mockReset();
    current = {
      id: "document-1",
      conversationId: "01990f4e-6650-7a33-a768-611e2e4bf4c7",
      title: "Trip plan",
      content: "Original source",
      revision: 1,
      lastEditedBy: "model",
      createdAt: BASE.toISOString(),
      updatedAt: BASE.toISOString(),
    };
    vi.mocked(getDocument)
      .mockReset()
      .mockImplementation(async ({ data }) =>
        data.documentId === "document-2"
          ? { ...current, id: "document-2", title: "Meeting notes" }
          : current,
      );
    vi.mocked(saveDocument)
      .mockReset()
      .mockImplementation(async ({ data }) => {
        if (data.expectedRevision !== current.revision)
          return { outcome: "conflict" as const, document: current };
        current = {
          ...current,
          content: data.content,
          revision: current.revision + 1,
          lastEditedBy: "user",
        };
        return { outcome: "updated" as const, document: current };
      });
    vi.mocked(toggleDocumentTask).mockReset().mockRejectedValue(new Error("not used"));
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
  });
  afterEach(() => {
    for (const rpc of [sendMock, retryMock, branchMock, editMock, answerMock, conversationMock])
      rpc.mockReset();
  });

  it("discovers a live tool-created document without a loader summary or automatic opening", async () => {
    const { client, container } = renderView();
    expect(getDocument).not.toHaveBeenCalled();
    liveDraft.tools = [toActivity(documentReference())];
    act(() =>
      client.setQueryData(
        ["conversation", "01990f4e-6650-7a33-a768-611e2e4bf4c7"],
        payload(null, {
          messages: [
            message("m-user", "user", "u1"),
            { ...message("m-answer", "assistant", ""), status: "streaming" },
          ],
        }),
      ),
    );
    const widget = await screen.findByRole("button", { name: "Open document: Trip plan" });
    expect(container.querySelector('[data-message-id="m-answer"]')).toContainElement(widget);
    expect(screen.queryByRole("textbox", { name: "Document source" })).not.toBeInTheDocument();
    fireEvent.click(widget);
    fireEvent.click(await screen.findByRole("button", { name: "Source" }));
    expect(await screen.findByRole("textbox", { name: "Document source" })).toHaveValue(
      "Original source",
    );
    expect(getDocument).toHaveBeenCalledWith({ data: { documentId: "document-1" } });
  });

  it("places a legacy loader summary in the final answer, never below the transcript", async () => {
    const { container } = renderView(null, {
      toolCalls: [documentReference()],
      documents: [{ id: "document-2", title: "Meeting notes" }],
    });
    const transcript = await screen.findByRole("button", { name: "Open document: Trip plan" });
    const legacy = await screen.findByRole("button", { name: "Open document: Meeting notes" });
    const answer = container.querySelector('[data-message-id="m-answer"]')!;
    expect(answer).toContainElement(transcript);
    expect(answer).toContainElement(legacy);
    expect(getDocument).toHaveBeenCalledWith({ data: { documentId: "document-1" } });
    expect(getDocument).toHaveBeenCalledWith({ data: { documentId: "document-2" } });
  });

  it("opens the document from a later update row, and locks the panel only while a row streams", async () => {
    const editRow = {
      ...documentReference(),
      id: "document-edit",
      toolName: "edit_document",
      turnIndex: 1,
      result: {
        outcome: "updated",
        documentId: "document-1",
        documentConversationId: "01990f4e-6650-7a33-a768-611e2e4bf4c7",
        title: "Trip plan",
        revision: 2,
      },
    };
    renderView(null, { toolCalls: [documentReference(), editRow] });

    // The compact row for the edit opens the same document as the card.
    const update = await screen.findByRole("button", { name: /Updated Trip plan/ });
    fireEvent.click(update);
    fireEvent.click(await screen.findByRole("button", { name: "Source" }));
    expect(await screen.findByRole("textbox", { name: "Document source" })).toHaveValue(
      "Original source",
    );
    // Nothing is generating, so the panel is editable.
    expect(
      screen.queryByText("Read-only while the assistant is answering."),
    ).not.toBeInTheDocument();
  });

  it("holds the document lock from the send until the streaming row appears", async () => {
    const { client } = renderView(null, { toolCalls: [documentReference()] });
    fireEvent.click(await screen.findByRole("button", { name: "Open document: Trip plan" }));
    expect(
      screen.queryByText("Read-only while the assistant is answering."),
    ).not.toBeInTheDocument();

    // The send resolves before the refetch reports the row it started; the lock
    // must not drop in that gap.
    const gate = draftWriteGate();
    sendMock.mockImplementationOnce((async () => {
      await gate.promise;
      return {};
    }) as never);
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
    // Presence, not visibility: the notice animates its height in.
    expect(
      await screen.findByText("Read-only while the assistant is answering."),
    ).toBeInTheDocument();
    await act(async () => {
      gate.release();
      await Promise.resolve();
    });
    expect(screen.getByText("Read-only while the assistant is answering.")).toBeInTheDocument();

    // Only a read that shows no streaming row releases it.
    act(() =>
      client.setQueryData(
        ["conversation", "01990f4e-6650-7a33-a768-611e2e4bf4c7"],
        payload(null, {
          toolCalls: [documentReference()],
          messages: [
            message("m-user", "user", "u1"),
            { ...message("m-answer", "assistant", ""), status: "streaming" },
          ],
        }),
      ),
    );
    expect(screen.getByText("Read-only while the assistant is answering.")).toBeInTheDocument();
    act(() =>
      client.setQueryData(
        ["conversation", "01990f4e-6650-7a33-a768-611e2e4bf4c7"],
        payload(null, { toolCalls: [documentReference()] }),
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByText("Read-only while the assistant is answering."),
      ).not.toBeInTheDocument(),
    );
  });

  it("drops the card once a retry has deleted the document that answer created", async () => {
    renderView(null, { toolCalls: [documentReference()] });
    expect(await screen.findByRole("button", { name: "Open document: Trip plan" })).toBeVisible();
    retryMock.mockResolvedValueOnce({} as never);
    // Retrying the creating answer deletes its document server-side, so the
    // row the card was reading is gone.
    vi.mocked(getDocument).mockResolvedValue(null);
    conversationMock.mockResolvedValueOnce(payload(null) as never);
    fireEvent.click(screen.getByRole("button", { name: "Retry m-answer" }));
    await waitFor(() => expect(retryMock).toHaveBeenCalled());

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Open document: Trip plan" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("keeps branch-copied references inert beside documents owned by this conversation", async () => {
    const { client, container } = renderView(
      { conversationId: "original", title: "Original" },
      { toolCalls: [documentReference("original", "other-document")] },
    );
    expect(screen.getByText("From another chat")).toBeVisible();
    expect(getDocument).not.toHaveBeenCalled();
    act(() =>
      client.setQueryData(
        ["conversation", "01990f4e-6650-7a33-a768-611e2e4bf4c7"],
        payload(null, {
          toolCalls: [documentReference("original", "other-document")],
          documents: [{ id: "document-1", title: "Trip plan" }],
        }),
      ),
    );
    const widget = await screen.findByRole("button", { name: "Open document: Trip plan" });
    expect(screen.getAllByRole("button", { name: /Open document/ })).toHaveLength(1);
    expect(container.querySelector('[data-message-id="m-answer"]')).toContainElement(widget);
    expect(screen.getByText("From another chat")).toBeVisible();
    expect(getDocument).not.toHaveBeenCalledWith({ data: { documentId: "other-document" } });
  });

  it.each(["send", "retry", "branch", "edit", "answer", "answer edit"] as const)(
    "flushes local source before %s reaches its RPC and focuses the open document",
    async (action) => {
      const start =
        action === "answer edit"
          ? resolvedPayload()
          : payload(null, action === "answer" ? { toolCalls: [askRow] } : {});
      const withDocument = {
        ...start,
        documents: [{ id: "document-1", title: "Trip plan" }],
      };
      renderView(null, withDocument);
      conversationMock.mockResolvedValue(withDocument as never);
      sendMock.mockResolvedValueOnce({} as never);
      retryMock.mockResolvedValueOnce({} as never);
      branchMock.mockResolvedValueOnce({ conversationId: "branch" } as never);
      editMock.mockResolvedValueOnce({} as never);
      answerMock.mockResolvedValueOnce({} as never);
      fireEvent.click(await screen.findByRole("button", { name: "Open document: Trip plan" }));
      fireEvent.click(await screen.findByRole("button", { name: "Source" }));
      const blocked = draftWriteGate();
      vi.mocked(saveDocument).mockImplementationOnce(async ({ data }) => {
        await blocked.promise;
        current = {
          ...current,
          content: data.content,
          revision: 2,
          lastEditedBy: "user",
        };
        return { outcome: "updated", document: current };
      });
      fireEvent.change(screen.getByRole("textbox", { name: "Document source" }), {
        target: { value: "Reviewed source" },
      });
      const rpc =
        action === "send"
          ? sendMock
          : action === "retry"
            ? retryMock
            : action === "branch"
              ? branchMock
              : action === "answer"
                ? answerMock
                : editMock;
      if (action === "edit") fireEvent.click(screen.getByRole("button", { name: "Edit m-user" }));
      if (action === "answer edit")
        fireEvent.click(screen.getByRole("button", { name: "Edit answers" }));
      const label = {
        send: "Send test message",
        retry: "Retry m-answer",
        branch: "Branch off m-answer",
        edit: "Save message edit",
        answer: "Skip and continue",
        "answer edit": "Save answers",
      }[action];
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() => expect(saveDocument).toHaveBeenCalledTimes(1));
      expect(rpc).not.toHaveBeenCalled();
      await act(async () => blocked.release());
      await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
      expect(current.content).toBe("Reviewed source");
      if (action !== "branch")
        expect(rpc).toHaveBeenCalledWith({
          data: expect.objectContaining({ openDocumentId: "document-1" }),
        });
    },
  );
});

describe("ChatView edit offers", () => {
  it("shows a skill picked while the editor is open", () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Edit m-user" }));
    expect(screen.getByTestId("edit-selection-m-user")).toHaveTextContent("|");
    fireEvent.click(screen.getByRole("button", { name: "Pick skill in edit m-user" }));
    // The chips are projected from the same memo as the transcript rows, and
    // reach it only through `saveEdit`'s identity. This pins that chain.
    expect(screen.getByTestId("edit-selection-m-user")).toHaveTextContent("s-picked");
  });

  it("sends the research offer the edit asked for, and forgets it on the next edit", async () => {
    editMock.mockResolvedValue({
      conversationId: "01990f4e-6650-7a33-a768-611e2e4bf4c7",
      assistantMessageId: "next",
    } as never);
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Edit m-user" }));
    fireEvent.click(screen.getByRole("button", { name: "Offer research in edit m-user" }));
    fireEvent.click(screen.getByRole("button", { name: "Save message edit" }));
    await waitFor(() =>
      expect(editMock).toHaveBeenCalledWith({
        data: expect.objectContaining({ researchEnabled: true }),
      }),
    );
    // The offer belongs to the edit that was written, not to the editor.
    editMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Edit m-user" }));
    fireEvent.click(screen.getByRole("button", { name: "Save message edit" }));
    await waitFor(() =>
      expect(editMock).toHaveBeenCalledWith({
        data: expect.objectContaining({ researchEnabled: false }),
      }),
    );
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
        data: { conversationId: "01990f4e-6650-7a33-a768-611e2e4bf4c7", messageId: "m-answer" },
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
