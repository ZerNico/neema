import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FakeEventSource } from "../../../../tests/fixtures/event-source.ts";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { DetailPanelProvider } from "~/ui/detail-panel.tsx";
import { ChatView } from "./chat-view.tsx";
import { MessageBubble, type DisplayMessage } from "./message-list.tsx";
import { getConversationWithMessages } from "../server/functions.ts";

vi.mock("../server/functions.ts", () => ({
  getConversationWithMessages: vi.fn(),
  listChatModels: vi.fn(),
  answerQuestion: vi.fn(),
  branchConversation: vi.fn(),
  editMessage: vi.fn(),
  resumeMessage: vi.fn(),
  retryMessage: vi.fn(),
  sendMessage: vi.fn(),
  stopGeneration: vi.fn(),
}));
vi.mock("~/modules/tools/server/functions.ts", () => ({
  getComposerAvailability: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: () => null,
  useNavigate: () => vi.fn(),
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: "/chat/c1" }, matches: [] }),
  useBlocker: vi.fn(),
}));
vi.mock("./composer.tsx", () => ({ Composer: () => null }));
// Keep the real stream hook, chronology, research disclosure and question controls;
// only replace viewport measurement and unrelated composer/upload UI.
vi.mock("./virtual-message-list.tsx", () => ({
  VirtualMessageList: ({ messages }: { messages: ReadonlyArray<DisplayMessage> }) =>
    messages.map((message) => <MessageBubble key={message.id} message={message} />),
}));
vi.mock("~/modules/attachments/client/use-attachment-uploads.ts", () => ({
  useAttachmentUploads: () => ({ items: [], seed: vi.fn(), reset: vi.fn(), submit: vi.fn() }),
}));

afterEach(() => vi.unstubAllGlobals());

it.each(["stream first", "detail first"])(
  "shows research questions without remounting when completion arrives %s",
  async (order) => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const now = new Date("2026-09-05T12:00:00Z");
    const message = {
      id: "m1",
      conversationId: "c1",
      role: "assistant",
      status: "streaming",
      content: "",
      reasoning: "",
      modelId: "model-1",
      generationId: "gen-1",
      questionResponse: null,
      usage: null,
      error: null,
      createdAt: now,
      completedAt: null,
      editedAt: null,
    };
    const payload = {
      conversation: { id: "c1", title: "Research", modelId: "model-1" },
      messages: [message],
      toolCalls: [],
      pendingChunks: [],
      window: { anchorId: "m1", olderCursor: null },
      priorSources: [],
      uiStates: [],
      latestMachineAttempt: null,
      compactionEvents: [],
      attachments: [],
      queue: [],
      queueState: null,
      branchedFrom: null,
      agentDrafts: [],
    };
    const questions = [
      { question: "Which area should I focus on?", options: [], multiSelect: false },
    ];
    const result = { v: 1, outcome: "presented", questions };
    const progress = {
      runId: "run-1",
      phase: "clarifying",
      tasks: [],
      limitations: [],
      usageComplete: true,
    };
    const root = {
      v: 1,
      family: "research",
      name: "deep_research",
      callId: "run-1",
      runId: "run-1",
      turnIndex: 0,
      callIndex: 0,
      textOffset: 0,
    };
    const ask = {
      v: 1,
      family: "ask",
      name: "ask_user",
      callId: "ask-1",
      turnIndex: 1,
      callIndex: 0,
      textOffset: 0,
    };
    client.setQueryData(["conversation", "c1"], payload);
    client.setQueryData(["chat-models"], [{ id: "model-1", capabilities: { tools: true } }]);
    client.setQueryData(["tools", "availability"], (current: object | undefined) => ({
      ...current,
      search: {
        enabled: true,
        configured: true,
      },
    }));
    vi.mocked(getConversationWithMessages).mockResolvedValue({
      ...payload,
      messages: [{ ...message, status: "complete", completedAt: now }],
      toolCalls: [
        {
          id: "run-1",
          messageId: "m1",
          toolName: "deep_research",
          family: "research",
          status: "complete",
          researchRunId: null,
          turnIndex: 0,
          callIndex: 0,
          textOffset: 0,
          arguments: {},
          result: { progress: { ...progress, phase: "complete" } },
          error: null,
        },
        {
          id: "ask-1",
          messageId: "m1",
          toolName: "ask_user",
          family: "ask",
          status: "complete",
          researchRunId: "run-1",
          turnIndex: 1,
          callIndex: 0,
          textOffset: 0,
          arguments: { questions },
          result,
          error: null,
        },
      ],
    } as never);
    render(
      <QueryClientProvider client={client}>
        <ConfirmProvider>
          <DetailPanelProvider>
            <ChatView conversationId="c1" />
          </DetailPanelProvider>
        </ConfirmProvider>
      </QueryClientProvider>,
    );
    const source = FakeEventSource.instances.find((entry) =>
      entry.url.includes("/messages/m1/stream"),
    )!;
    // The stream is fenced by the attempt, not by the run a call inside it made.
    expect(source.url).toContain("generationId=gen-1");
    act(() => {
      source.emit("chunk", {
        seq: 1,
        kind: "tool",
        generationId: "gen-1",
        delta: JSON.stringify({ ...root, phase: "progress", progress }),
      });
      source.emit("chunk", {
        seq: 2,
        kind: "tool",
        generationId: "gen-1",
        delta: JSON.stringify({ ...ask, phase: "start" }),
      });
    });
    if (order === "detail first") {
      await act(async () => {
        await client.invalidateQueries({ queryKey: ["conversation", "c1"] });
      });
      // A sync refresh can observe completion before the one-second DB stream tail.
      // It must not disconnect that tail while its question/result chunks are pending.
      expect(source.close).not.toHaveBeenCalled();
    }
    act(() => {
      source.emit("chunk", {
        seq: 3,
        kind: "tool",
        generationId: "gen-1",
        delta: JSON.stringify({ ...ask, phase: "result", result }),
      });
    });
    expect(screen.getByText(questions[0]!.question)).toBeInTheDocument();
    const draft = screen.getByRole("textbox", { name: "Your answer" });
    fireEvent.change(draft, { target: { value: "Focus on access and cost" } });
    expect(screen.getByRole("button", { name: "Send answers" })).toBeDisabled();
    act(() => {
      source.emit("chunk", {
        seq: 4,
        kind: "tool",
        generationId: "gen-1",
        delta: JSON.stringify({
          ...root,
          phase: "result",
          progress: { ...progress, phase: "complete" },
        }),
      });
      source.emit("done", { status: "complete", generationId: "gen-1" });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Send answers" })).toBeEnabled());
    expect(screen.getByRole("textbox", { name: "Your answer" })).toBe(draft);
    expect(draft).toHaveValue("Focus on access and cost");
    // The call returned before the host asked, so its settled row stands above
    // the question card rather than still claiming to be running.
    expect(screen.queryByText("Researching")).not.toBeInTheDocument();
    expect(getConversationWithMessages).toHaveBeenCalled();
    vi.mocked(getConversationWithMessages).mockClear();
    client.clear();
  },
);
