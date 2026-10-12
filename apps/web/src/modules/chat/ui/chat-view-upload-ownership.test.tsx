import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAPABILITY_KEYS } from "~/modules/groups/policy.ts";
import { uploadAttachment, deleteAttachment } from "~/modules/attachments/server/functions.ts";
import { editMessage, getConversationWithMessages, queueMessage } from "../server/functions.ts";
import type { DisplayMessage } from "./message-list.tsx";
import { ChatView } from "./chat-view.tsx";
import { createLiveText } from "../client/live-text.ts";
import { setComposerText } from "./composer-test-utils.ts";
import { FakeEventSource } from "../../../../tests/fixtures/event-source.ts";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { DetailPanelProvider } from "~/ui/detail-panel.tsx";
import { HeaderSlotProvider } from "~/ui/header-slot.tsx";
import { AppMotionProvider } from "~/ui/motion.tsx";

const state = vi.hoisted(() => ({ streaming: true }));
vi.mock("../server/functions.ts", () => ({
  abortWorkTurn: vi.fn(),
  activateWorkTurn: vi.fn(),
  getConversationWithMessages: vi.fn(),
  getConversationHistory: vi.fn(),
  getWorkTurnReservation: vi.fn(),
  listConversations: vi.fn(),
  reserveWorkTurn: vi.fn(),
  listChatModels: vi.fn(),
  branchConversation: vi.fn(),
  sendMessage: vi.fn(),
  answerQuestion: vi.fn(),
  resumeMessage: vi.fn(),
  retryMessage: vi.fn(),
  editMessage: vi.fn(),
  stopGeneration: vi.fn(),
  queueMessage: vi.fn(),
  replaceQueuedMessage: vi.fn(),
  removeQueuedMessage: vi.fn(),
  dispatchQueuedMessage: vi.fn(),
  sendQueuedNow: vi.fn(),
  steerQueuedMessage: vi.fn(),
}));
vi.mock("~/modules/attachments/server/functions.ts", () => ({
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
  getDocumentParsingAvailability: vi.fn(),
}));
vi.mock("~/modules/integrations/server/functions.ts", () => ({
  listAdminIntegrations: vi.fn().mockResolvedValue([]),
  listChatIntegrations: vi.fn().mockResolvedValue([]),
  listIntegrationScopeOptions: vi.fn().mockResolvedValue([]),
  listKnowledgeSources: vi.fn().mockResolvedValue([]),
  listMyIntegrations: vi.fn().mockResolvedValue([]),
  listPendingIntegrationCalls: vi.fn().mockResolvedValue([]),
  setConversationIntegration: vi.fn(),
}));
vi.mock("~/modules/skills/server/functions.ts", () => ({
  listSkills: vi.fn().mockResolvedValue([]),
}));
vi.mock("~/modules/agents/server/functions.ts", () => ({ listAgents: vi.fn(), getAgent: vi.fn() }));
vi.mock("~/modules/agents/server/draft-functions.ts", () => ({
  getAgentDraft: vi.fn(),
  patchAgentDraft: vi.fn(),
  saveAgentDraft: vi.fn(),
  reloadAgentDraft: vi.fn(),
}));
vi.mock("~/modules/documents/server/document-functions.ts", () => ({
  getDocument: vi.fn(),
  pushDocument: vi.fn(),
  listDocuments: vi.fn(),
}));
vi.mock("~/modules/tools/server/functions.ts", () => ({
  getWebSearchAvailability: vi.fn(),
  getResearchAvailability: vi.fn(),
}));
vi.mock("~/modules/knowledge/server/functions.ts", () => ({
  listKnowledgeCollections: vi.fn(),
  getKnowledgeCollection: vi.fn(),
  createKnowledgeCollection: vi.fn(),
  updateKnowledgeCollection: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
  useRouterState: ({ select }: { select: (value: unknown) => unknown }) =>
    select({ location: { pathname: "/chat/c1" }, matches: [] }),
  useBlocker: vi.fn(),
}));

// Transcript rendering is separate; expose the real view's edit upload actions.
vi.mock("./virtual-message-list.tsx", () => ({
  VirtualMessageList: ({ messages }: { messages: readonly DisplayMessage[] }) => (
    <div>
      {messages.map((message) => (
        <div key={message.id}>
          <button disabled={message.editDisabled} onClick={message.onEdit}>
            Edit {message.id}
          </button>
          {message.editState ? (
            <>
              <input
                aria-label="Edit upload"
                type="file"
                onChange={(event) => message.editState!.attachments.addFiles(event.target.files!)}
              />
              <button onClick={() => message.editState!.onSave("Changed user message")}>
                Save message edit
              </button>
              <button onClick={message.editState.onCancel}>Cancel message edit</button>
              {message.editState.attachments.items.map((item) => (
                <button
                  key={item.localId}
                  onClick={() => message.editState!.attachments.remove(item.localId)}
                >
                  Remove edit {item.fileName}
                </button>
              ))}
            </>
          ) : null}
        </div>
      ))}
    </div>
  ),
}));
const live = createLiveText({ text: "", reasoning: "", reasoningSeen: false, lastSeq: 0 });
vi.mock("../client/use-message-stream.ts", async (original) => ({
  ...(await original<typeof import("../client/use-message-stream.ts")>()),
  useMessageStream: () => ({
    files: [],
    tools: [],
    compactions: [],
    steers: [],
    lookups: { images: {}, places: {}, routes: {} },
    live,
    status: state.streaming ? "streaming" : "complete",
  }),
}));

const conversationId = "01990f4e-6650-7a33-a768-611e2e4bf4c7";
const date = new Date("2026-03-01T12:00:00Z");
const message = (id: string, role: "user" | "assistant", content: string) => ({
  id,
  conversationId,
  role,
  status: "complete" as const,
  content,
  reasoning: "",
  modelId: "m1",
  usage: null,
  generationId: null,
  generationLeaseUntil: null,
  assistantOutput: null,
  error: null,
  createdAt: date,
  completedAt: date,
  editedAt: null,
  questionResponse: null,
  steeredIntoMessageId: null,
  steerTextOffset: null,
  steerTurnIndex: null,
});
function setup() {
  const payload: Awaited<ReturnType<typeof getConversationWithMessages>> = {
    conversation: {
      id: conversationId,
      userId: "u1",
      title: "Current chat",
      mode: "chat",
      modelId: "m1",
      branchedFrom: null,
      createdAt: date,
      updatedAt: date,
      lastMessageAt: date,
      permissionLevel: "auto",
      temporary: false,
      projectId: null,
      archivedAt: null,
      deletedAt: null,
      unread: false,
      scheduleId: null,
      fileReferenceAliases: null,
    },
    messages: [
      message("user", "user", "Hi"),
      {
        ...message("answer", "assistant", "Answer"),
        status: state.streaming ? "streaming" : "complete",
      },
    ],
    pendingChunks: [],
    agent: null,
    agentDrafts: [],
    documents: [],
    generations: [],
    toolCalls: [],
    attachments: [],
    window: { anchorId: "user", olderCursor: null },
    priorSources: [],
    uiStates: [],
    latestMachineAttempt: null,
    queue: [],
    queueState: null,
    branchedFrom: null,
    compactionEvents: [],
    scheduleDrafts: [],
    workingFiles: [],
    referenceAttachments: [],
    serverTime: date.getTime(),
    schedule: null,
    project: null,
  };
  vi.mocked(getConversationWithMessages).mockResolvedValue(payload);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["capabilities"], {
    ...Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, false])),
    attachments: true,
  });
  client.setQueryData(["tools", "document-parsing", "availability"], {
    configured: false,
    enabled: false,
  });
  client.setQueryData(["conversation", conversationId], payload);
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
        contextLength: 128000,
        capabilities: { reasoning: false, tools: true, vision: false, files: false },
      },
    ],
  );
  client.setQueryData(["skills"], []);
  client.setQueryData(["knowledge", "collections"], []);
  client.setQueryData(["tools", "web-search", "availability"], {
    configured: false,
    enabled: false,
  });
  return render(
    <QueryClientProvider client={client}>
      <AppMotionProvider>
        <ConfirmProvider>
          <DetailPanelProvider>
            <HeaderSlotProvider>
              <Suspense fallback={null}>
                <ChatView conversationId={conversationId} />
              </Suspense>
            </HeaderSlotProvider>
          </DetailPanelProvider>
        </ConfirmProvider>
      </AppMotionProvider>
    </QueryClientProvider>,
  );
}
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
beforeEach(() => {
  vi.clearAllMocks();
  state.streaming = true;
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("External fetch blocked")));
  vi.mocked(uploadAttachment).mockResolvedValue({
    id: "A",
    fileName: "notes.txt",
    size: 5,
    mediaType: "text/plain",
    kind: "text",
  });
  vi.mocked(deleteAttachment).mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe("ChatView submitted upload ownership", () => {
  it.each(["accept", "reject", "unmount-accept", "unmount-reject"])(
    "retains queued A through %s and keeps later B independent",
    async (outcome) => {
      const pending = deferred<Awaited<ReturnType<typeof queueMessage>>>();
      vi.mocked(queueMessage).mockReturnValueOnce(pending.promise);
      const view = setup();
      const textbox = await screen.findByRole("textbox");
      setComposerText(textbox, "Submitted A");
      fireEvent.change(view.container.querySelector('input[type="file"]')!, {
        target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
      });
      await screen.findByRole("button", { name: "Remove notes.txt" });
      fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
      await waitFor(() => expect(queueMessage).toHaveBeenCalledOnce());
      expect(queueMessage).toHaveBeenCalledWith({
        data: expect.objectContaining({ attachmentIds: ["A"] }),
      });
      fireEvent.click(screen.getByRole("button", { name: "Remove notes.txt" }));
      expect(deleteAttachment).not.toHaveBeenCalled();
      vi.mocked(uploadAttachment).mockResolvedValueOnce({
        id: "B",
        fileName: "later.txt",
        size: 5,
        mediaType: "text/plain",
        kind: "text",
      });
      setComposerText(textbox, "Later B");
      fireEvent.change(view.container.querySelector('input[type="file"]')!, {
        target: { files: [new File(["later"], "later.txt", { type: "text/plain" })] },
      });
      await screen.findByRole("button", { name: "Remove later.txt" });
      if (outcome.startsWith("unmount")) view.unmount();
      await act(async () =>
        outcome.endsWith("accept")
          ? pending.resolve({ entryId: "entry-A" })
          : pending.reject(new Error("Queue refused")),
      );
      if (outcome.endsWith("reject"))
        await waitFor(() =>
          expect(deleteAttachment).toHaveBeenCalledWith({ data: { attachmentId: "A" } }),
        );
      else expect(deleteAttachment).not.toHaveBeenCalledWith({ data: { attachmentId: "A" } });
      if (!outcome.startsWith("unmount"))
        expect(screen.getByRole("button", { name: "Remove later.txt" })).toBeEnabled();
    },
  );

  it.each(["accept", "reject", "unmount-accept", "unmount-reject"])(
    "retains inline-edit A through cancel and %s without sending local release callbacks",
    async (outcome) => {
      state.streaming = false;
      const pending = deferred<Awaited<ReturnType<typeof editMessage>>>();
      vi.mocked(editMessage).mockReturnValueOnce(pending.promise);
      const view = setup();
      fireEvent.click(await screen.findByRole("button", { name: "Edit user" }));
      fireEvent.change(await screen.findByLabelText("Edit upload"), {
        target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
      });
      await screen.findByRole("button", { name: "Remove edit notes.txt" });
      fireEvent.click(screen.getByRole("button", { name: "Save message edit" }));
      await waitFor(() => expect(editMessage).toHaveBeenCalledOnce());
      expect(vi.mocked(editMessage).mock.calls[0]![0].data).not.toHaveProperty("releaseUploads");
      expect(vi.mocked(editMessage).mock.calls[0]![0].data.attachmentIds).toEqual(["A"]);
      fireEvent.click(screen.getByRole("button", { name: "Cancel message edit" }));
      expect(deleteAttachment).not.toHaveBeenCalled();
      if (outcome.startsWith("unmount")) view.unmount();
      await act(async () =>
        outcome.endsWith("accept")
          ? pending.resolve({ assistantMessageId: "next-answer" })
          : pending.reject(new Error("Edit refused")),
      );
      if (outcome.endsWith("reject"))
        await waitFor(() =>
          expect(deleteAttachment).toHaveBeenCalledWith({ data: { attachmentId: "A" } }),
        );
      else expect(deleteAttachment).not.toHaveBeenCalledWith({ data: { attachmentId: "A" } });
    },
  );
});
