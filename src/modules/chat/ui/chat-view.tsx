import { SkillActivity, SkillToolName } from "~/modules/skills/tool-schema.ts";
import { applyImageChunk } from "../client/use-message-stream.ts";
import type { AssistantImage } from "../assistant-output.ts";
import { collectSources } from "./citations.ts";
import { KnowledgeActivityResult, KnowledgeToolName } from "~/modules/knowledge/tool-schema.ts";
import { Option, Schema } from "effect";
import { GitBranchIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { conversationQuery } from "../client/queries.ts";
import { browserTimeZone } from "../client/time-zone.ts";
import {
  applyCompactionChunk,
  applyToolChunk,
  toMemoryActivityOutcome,
  toMemoryActivityReason,
  readTextOffset,
  readResearchProgress,
  useMessageStream,
  type CompactionActivity,
  type ToolActivity,
  type ToolPageStatus,
  type ToolSource,
} from "../client/use-message-stream.ts";
import {
  answerQuestion,
  branchConversation,
  editMessage,
  retryMessage,
  sendMessage,
  stopGeneration,
} from "../server/functions.ts";
import type { GenerationMode } from "../research-schema.ts";
import { Composer, type ComposerHandle } from "./composer.tsx";
import { agentIcon } from "./context-picker.tsx";
import { greetingFor } from "./greeting.ts";
import { associateQuestionResponses } from "./question-responses.ts";
import { buildMessageStamps } from "./timestamps.ts";
import { useSearchMode } from "./use-search-mode.ts";
import { useContextSelection } from "./use-context-selection.ts";
import type { DisplayMessage } from "./message-list.tsx";
import { VirtualMessageList } from "./virtual-message-list.tsx";
import { ResearchPanelOwner } from "./research-panel.tsx";
import { useAttachmentUploads } from "~/modules/attachments/client/use-attachment-uploads.ts";
import type { MessageAttachment } from "~/modules/attachments/schema.ts";
import { readPresentedQuestions, type QuestionResponse } from "~/modules/tools/ask-user-schema.ts";
import { PlanToolResult } from "~/modules/tools/plan-schema.ts";
import { mergeSource } from "~/modules/tools/sources.ts";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Button } from "~/ui/primitives/button";
import { useConfirm } from "~/ui/confirm.tsx";
import { useIsMobile } from "~/ui/use-mobile.ts";
import { useDocumentTitle } from "~/ui/use-document-title.ts";
import { useHydrated } from "~/ui/use-hydrated.ts";
import { cn } from "~/ui/utils";

// Durable message_tool_calls row → the same family-discriminated shape used by
// live chunks. The tool name is the durable discriminator; old web rows never
// carried a family field of their own.
export function toActivity(row: {
  id: string;
  toolName: string;
  arguments: unknown;
  result: unknown;
  status: "running" | "complete" | "error";
  turnIndex: number;
  callIndex: number;
  textOffset?: number | null;
  researchRunId?: string | null;
  researchTaskId?: string | null;
  error: { code: string; message: string } | null;
}): ToolActivity {
  const textOffset = readTextOffset(row.textOffset);
  const position = textOffset === undefined ? {} : { textOffset };
  if (Schema.is(SkillToolName)(row.toolName)) {
    const result = Option.getOrNull(Schema.decodeUnknownOption(SkillActivity)(row.result));
    return {
      family: "skill",
      ...position,
      callId: row.id,
      name: row.toolName,
      turnIndex: row.turnIndex,
      callIndex: row.callIndex,
      skillId: result?.skillId ?? "",
      skillName: result?.skillName ?? "Skill",
      path: result?.path ?? "",
      status:
        row.status === "running" ? "running" : result?.status === "complete" ? "complete" : "error",
      ...(row.researchRunId ? { runId: row.researchRunId } : {}),
      ...(row.researchTaskId ? { taskId: row.researchTaskId } : {}),
    };
  }
  if (row.toolName === "update_plan") {
    const result = Option.getOrNull(Schema.decodeUnknownOption(PlanToolResult)(row.result));
    const steps = result?.outcome === "updated" ? result.steps : null;
    return {
      family: "plan",
      ...position,
      callId: row.id,
      name: row.toolName,
      turnIndex: row.turnIndex,
      callIndex: row.callIndex,
      status: row.status === "running" ? "running" : steps ? "complete" : "error",
      ...(steps ? { steps } : {}),
    };
  }
  if (Schema.is(KnowledgeToolName)(row.toolName)) {
    const result = Option.getOrNull(
      Schema.decodeUnknownOption(KnowledgeActivityResult)(row.result),
    );
    return {
      family: "knowledge",
      ...position,
      callId: row.id,
      name: row.toolName,
      ...(row.researchRunId ? { runId: row.researchRunId } : {}),
      ...(row.researchTaskId ? { taskId: row.researchTaskId } : {}),
      turnIndex: row.turnIndex,
      callIndex: row.callIndex,
      status: row.status === "complete" && (!result || !result.ok) ? "error" : row.status,
      ...(result ? { summary: result.summary, sources: [...result.sources] } : {}),
      ...(row.error ? { error: row.error.message } : result?.error ? { error: result.error } : {}),
    };
  }
  if (row.toolName === "deep_research") {
    const result = (row.result ?? {}) as { progress?: unknown; sources?: ToolSource[] };
    const progress = readResearchProgress(result.progress);
    return {
      family: "research",
      ...position,
      callId: row.id,
      name: row.toolName,
      turnIndex: row.turnIndex,
      callIndex: row.callIndex,
      status: progress ? row.status : "error",
      ...(progress ? { progress, runId: progress.runId } : {}),
      ...(result.sources ? { sources: result.sources } : {}),
      ...(row.error ? { error: row.error.message } : {}),
    };
  }
  if (row.toolName === "ask_user") {
    const questions = readPresentedQuestions(row.result);
    return {
      family: "ask",
      ...position,
      callId: row.id,
      name: row.toolName,
      turnIndex: row.turnIndex,
      callIndex: row.callIndex,
      status: row.status === "complete" && !questions ? "error" : row.status,
      ...(questions ? { questions } : {}),
      ...(row.error ? { error: row.error.message } : {}),
    };
  }
  if (row.toolName === "save_memory") {
    const result = (row.result ?? {}) as { outcome?: unknown; reason?: unknown };
    const outcome = toMemoryActivityOutcome(result.outcome);
    const reason = toMemoryActivityReason(result.reason);
    return {
      family: "memory",
      ...position,
      callId: row.id,
      name: row.toolName,
      turnIndex: row.turnIndex,
      callIndex: row.callIndex,
      status: row.status,
      ...(outcome ? { outcome } : {}),
      ...(reason ? { reason } : {}),
      ...(row.error ? { error: row.error.message } : {}),
    };
  }

  const args = (row.arguments ?? {}) as { queries?: string[]; urls?: string[] };
  const result = (row.result ?? {}) as {
    targets?: string[];
    resultCount?: number;
    pagesFetched?: number;
    pages?: ToolPageStatus[];
    sources?: ToolSource[];
  };
  return {
    family: "web",
    ...position,
    ...(row.researchRunId ? { runId: row.researchRunId } : {}),
    ...(row.researchTaskId ? { taskId: row.researchTaskId } : {}),
    callId: row.id,
    name: row.toolName,
    turnIndex: row.turnIndex,
    callIndex: row.callIndex,
    targets: result.targets ?? args.queries ?? args.urls ?? [],
    status: row.status,
    ...(result.resultCount !== undefined ? { resultCount: result.resultCount } : {}),
    ...(result.pagesFetched !== undefined ? { pagesFetched: result.pagesFetched } : {}),
    ...(result.pages !== undefined ? { pages: result.pages } : {}),
    ...(result.sources !== undefined ? { sources: result.sources } : {}),
    ...(row.error ? { error: row.error.message } : {}),
  };
}

function toCompactionActivity(row: {
  id: string;
  beforeTurnIndex: number;
  passIndex: number;
  scope: "history" | "active_rounds";
  status: "running" | "complete" | "error";
  outcome: "summary" | "hard_truncation" | null;
  summary: string | null;
  textOffset?: number | null;
  researchRunId?: string | null;
  researchTaskId?: string | null;
}): CompactionActivity {
  const textOffset = readTextOffset(row.textOffset);
  return {
    eventId: row.id,
    ...(row.researchRunId ? { runId: row.researchRunId } : {}),
    ...(row.researchTaskId ? { taskId: row.researchTaskId } : {}),
    ...(textOffset === undefined ? {} : { textOffset }),
    beforeTurnIndex: row.beforeTurnIndex,
    passIndex: row.passIndex,
    scope: row.scope,
    status: row.status === "error" ? "failed" : row.status,
    ...(row.outcome ? { outcome: row.outcome } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
  };
}

export function ChatView({ conversationId }: { conversationId: string }) {
  const composer = useRef<ComposerHandle>(null);
  const isMobile = useIsMobile();
  // Opening a chat should leave the caret ready to type. Not on a phone: that
  // would raise the keyboard over the conversation the user came to read.
  useEffect(() => {
    if (!isMobile) composer.current?.focus();
  }, [conversationId, isMobile]);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { data } = useSuspenseQuery(conversationQuery(conversationId));
  // Stays in step with an asynchronously generated title: `conversation.updated`
  // invalidates this query, so the tab renames itself when the title lands.
  useDocumentTitle(data.conversation.title);
  const [modelId, setModelId] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  // One instance, mounted for the whole view: an edit opens by seeding it, so
  // the chips survive the ChatInput remount that swapping the bubble causes.
  const editUploads = useAttachmentUploads();
  const seedEditUploads = editUploads.seed;
  const resetEditUploads = editUploads.reset;
  const submitEditUploads = editUploads.submit;
  const editUploadCount = editUploads.items.length;
  const activeEditingMessage =
    editingMessageId === null
      ? null
      : (data.messages.find((message) => message.id === editingMessageId) ?? null);
  // Bumped on retry/edit: the assistant id usually stays the same, so the
  // stream hook needs a separate signal to resubscribe from seq 0.
  const [retryEpoch, setRetryEpoch] = useState(0);

  const streamingMessage = data.messages.find((m) => m.status === "streaming");
  // The row the stream overlay applies to. Sticky beyond streamingMessage:
  // when the generation finishes, the sync bus refetches the conversation and
  // the row flips to complete with its full content BEFORE the smoothed text
  // has drained — dropping the overlay at that moment would pop the tail in,
  // exactly what smoothing exists to prevent. (Guarded render-time adjust.)
  const [overlayId, setOverlayId] = useState<string | null>(null);
  if (streamingMessage && streamingMessage.id !== overlayId) {
    setOverlayId(streamingMessage.id);
  }
  // oxlint-disable react/memo-dependencies -- pendingChunks are a snapshot for this streaming generation
  const initialStream = useMemo(() => {
    if (!streamingMessage) return null;
    const text = data.pendingChunks
      .filter((c) => c.kind === "text")
      .map((c) => c.delta)
      .join("");
    const reasoningChunks = data.pendingChunks.filter((c) => c.kind === "reasoning");
    const reasoning = reasoningChunks.map((c) => c.delta).join("");
    const lastSeq = data.pendingChunks.at(-1)?.seq ?? 0;
    // Seed tool activity from durable rows; live envelopes upsert on top.
    const durableTools = data.toolCalls
      .filter((t) => t.messageId === streamingMessage.id)
      .map(toActivity);
    // Starts can land between snapshots. Replay explicit anchors for every
    // family; terminal durable activities ignore older progress in the reducer.
    const tools = data.pendingChunks
      .filter((chunk) => chunk.kind === "tool")
      .reduce<ToolActivity[]>(
        (current, chunk) => applyToolChunk(current, chunk.delta),
        durableTools,
      );
    // Seed durable activity first; replayed chunks then idempotently overlay
    // any terminal marker that landed after the query snapshot.
    const durableCompactions = data.compactionEvents
      .filter((event) => event.messageId === streamingMessage.id)
      .map(toCompactionActivity);
    const compactions = data.pendingChunks
      .filter((c) => c.kind === "compaction")
      .reduce<CompactionActivity[]>(
        (current, c) => applyCompactionChunk(current, c.delta),
        durableCompactions,
      );
    return {
      images: data.pendingChunks
        .filter((chunk) => chunk.kind === "image")
        .reduce<AssistantImage[]>(
          (images, chunk) => applyImageChunk(images, chunk.delta),
          [...(streamingMessage.assistantOutput?.images ?? [])],
        ),
      text,
      reasoning,
      reasoningSeen: reasoningChunks.length > 0,
      tools,
      compactions,
      lastSeq,
    };
  }, [
    streamingMessage?.id,
    streamingMessage?.researchRunId,
    streamingMessage?.generationId,
    retryEpoch,
  ]);
  // oxlint-enable react/memo-dependencies

  // A sync refresh can see the terminal row before SSE has delivered its last
  // chunks and done marker. Keep that subscription alive so the sticky overlay
  // can drain instead of getting stranded with stale tools and streaming status.
  const subscribedMessage =
    streamingMessage ?? data.messages.find((message) => message.id === overlayId);
  const stream = useMessageStream(
    subscribedMessage?.id ?? null,
    initialStream,
    conversationId,
    retryEpoch,
    subscribedMessage?.researchRunId ?? subscribedMessage?.generationId ?? null,
  );

  const questionResponses = useMemo(
    () => associateQuestionResponses(data.messages, data.toolCalls, data.attachments),
    [data.messages, data.toolCalls, data.attachments],
  );
  const editingAnswers =
    activeEditingMessage !== null &&
    questionResponses.hiddenMessageIds.has(activeEditingMessage.id);
  const effectiveModelId = modelId ?? data.conversation.modelId;
  const {
    enabled: searchEnabled,
    setEnabled: setSearchEnabled,
    reset: resetSearchEnabled,
  } = useSearchMode();
  const context = useContextSelection({ mode: "installed", agent: data.agent });

  const sendMutation = useMutation({
    onMutate: () => setEditingMessageId(null),
    mutationFn: (input: {
      content: string;
      attachmentIds: ReadonlyArray<string>;
      generationMode?: GenerationMode;
      skillIds?: ReadonlyArray<string>;
    }) =>
      sendMessage({
        data: {
          conversationId,
          modelId: effectiveModelId!,
          content: input.content,
          searchEnabled,
          timeZone: browserTimeZone(),
          attachmentIds: input.attachmentIds,
          ...(input.generationMode ? { generationMode: input.generationMode } : {}),
          skillIds: [...(input.skillIds ?? [])],
          ...context.sendFields,
        },
      }),
    onSuccess: () => {
      resetSearchEnabled();
      context.settle();
      void queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
    },
  });

  // A transport failure may still have committed the next turn. Keep all
  // controls locked until a fresh authoritative tail makes retrying safe.
  const [questionNeedsRefresh, setQuestionNeedsRefresh] = useState(false);
  const refreshQuestionMutation = useMutation({
    mutationFn: () =>
      queryClient.invalidateQueries(
        { queryKey: ["conversation", conversationId] },
        { throwOnError: true },
      ),
    onSuccess: () => setQuestionNeedsRefresh(false),
    onError: () => toast.error("Could not refresh the chat. Refresh before answering again."),
  });
  const refreshQuestionState = async () => {
    try {
      // Await authoritative state even on transport errors before reopening a card.
      await queryClient.invalidateQueries(
        { queryKey: ["conversation", conversationId] },
        { throwOnError: true },
      );
    } catch {
      setQuestionNeedsRefresh(true);
      toast.error("Could not refresh the chat. Refresh before answering again.");
    }
  };
  const answerMutation = useMutation({
    onMutate: () => setEditingMessageId(null),
    mutationFn: (input: { callId: string; response: QuestionResponse }) =>
      answerQuestion({
        data: {
          conversationId,
          ...input,
          modelId: effectiveModelId!,
          searchEnabled,
          timeZone: browserTimeZone(),
        },
      }),
    onError: () => toast.error("Could not send your answers. Your draft has been kept."),
    onSettled: refreshQuestionState,
  });
  const mutateAnswer = answerMutation.mutateAsync;
  const answerInFlight = useRef(false);

  const retryMutation = useMutation({
    onMutate: () => setEditingMessageId(null),
    // `modelId` omitted regenerates with the model that answered before; an
    // explicit choice also selects the composer model once the retry succeeds.
    // The persisted conversation default and earlier messages keep theirs.
    mutationFn: (input: { messageId: string; modelId?: string }) =>
      retryMessage({ data: { conversationId, ...input, timeZone: browserTimeZone() } }),
    onSuccess: async (_result, input) => {
      if (input.modelId !== undefined) setModelId(input.modelId);
      // Refetch BEFORE bumping the epoch: the retried generation restarts at
      // seq 1, so the new subscription must be seeded from the wiped message
      // (after=0), not from the previous generation's chunk cursor.
      await queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
      setRetryEpoch((e) => e + 1);
    },
  });

  // Branching leaves this conversation untouched and opens the copy, so the
  // only cache work here is making the new chat show up in the lists.
  const branchMutation = useMutation({
    onMutate: () => setEditingMessageId(null),
    mutationFn: (messageId: string) => branchConversation({ data: { conversationId, messageId } }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
      await navigate({
        to: "/chat/$conversationId",
        params: { conversationId: result.conversationId },
      });
    },
  });

  const stopMutation = useMutation({
    mutationFn: (input: { messageId: string; researchRunId?: string; generationId?: string }) =>
      stopGeneration({ data: { conversationId, ...input } }),
    // No invalidation here: the generation finalizes itself and the `done`
    // event already carries the terminal status back through the stream hook.
  });

  const editMutation = useMutation({
    mutationFn: (
      input: {
        messageId: string;
        modelId: string;
        searchEnabled: boolean;
        attachmentIds: ReadonlyArray<string>;
      } & (
        | { content: string; questionResponse?: never }
        | { questionResponse: QuestionResponse; content?: never }
      ),
    ) => editMessage({ data: { conversationId, ...input, timeZone: browserTimeZone() } }),
    onSuccess: async (_result, input) => {
      if (input.questionResponse) {
        await refreshQuestionState();
      } else {
        await queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
        // Only ordinary edits claim uploads and consume the composer's search mode.
        editUploads.markClaimed();
        resetSearchEnabled();
      }
      setEditingMessageId(null);
      setRetryEpoch((epoch) => epoch + 1);
    },
    onError: async (_error, input) => {
      if (!input.questionResponse) return;
      toast.error("Could not save your answers. Your draft has been kept.");
      await refreshQuestionState();
    },
  });

  const mutateRetry = retryMutation.mutate;
  const mutateBranch = branchMutation.mutate;
  const mutateEdit = editMutation.mutate;
  const mutateQuestionEdit = editMutation.mutateAsync;
  const editPending = editMutation.isPending;

  // Retry rewinds the conversation to that response: retrying anything but
  // the last one deletes the messages after it, so it asks first.
  const lastAssistantId = [...data.messages].reverse().find((m) => m.role === "assistant")?.id;
  const generating =
    sendMutation.isPending || answerMutation.isPending || stream.status === "streaming";
  const mutationPending =
    answerMutation.isPending ||
    questionNeedsRefresh ||
    sendMutation.isPending ||
    retryMutation.isPending ||
    editMutation.isPending ||
    branchMutation.isPending;
  // An answer draft is local to its card; only submitting it locks the chat.
  const actionsDisabled =
    questionNeedsRefresh ||
    generating ||
    retryMutation.isPending ||
    editMutation.isPending ||
    branchMutation.isPending ||
    (activeEditingMessage !== null && !editingAnswers);
  // React Query keeps mutateAsync stable; React Compiler rejects that redundant dependency.
  // oxlint-disable react-hooks/exhaustive-deps
  const respondToQuestion = useCallback(
    async (callId: string, response: QuestionResponse) => {
      if (actionsDisabled || !effectiveModelId || answerInFlight.current) {
        throw new Error("Question response unavailable");
      }
      answerInFlight.current = true;
      try {
        return await mutateAnswer({ callId, response });
      } finally {
        answerInFlight.current = false;
      }
    },
    [actionsDisabled, effectiveModelId],
  );
  // oxlint-enable react-hooks/exhaustive-deps
  const tailMessageId = data.messages.at(-1)?.id;

  const retry = useCallback(
    async (messageId: string, pickedModelId?: string) => {
      if (
        messageId !== lastAssistantId &&
        !(await confirm({
          title: "Retry this response?",
          description: "All messages after it will be removed.",
          confirmLabel: "Retry",
        }))
      ) {
        return;
      }
      mutateRetry(
        pickedModelId === undefined ? { messageId } : { messageId, modelId: pickedModelId },
      );
    },
    [confirm, lastAssistantId, mutateRetry],
  );
  const branchAt = useCallback((messageId: string) => mutateBranch(messageId), [mutateBranch]);

  // Only offered for a generation this client can actually see running.
  const stoppableId = stream.status === "streaming" ? streamingMessage?.id : undefined;

  const attachmentsByMessage = useMemo(() => {
    const grouped = new Map<string, MessageAttachment[]>();
    for (const attachment of data.attachments) {
      const list = grouped.get(attachment.messageId);
      if (list) list.push(attachment);
      else grouped.set(attachment.messageId, [attachment]);
    }
    return grouped;
  }, [data.attachments]);

  // Grouped once per query result — the display map below runs on every
  // stream chunk and must not rescan the flat list per message.
  const toolCallsByMessage = useMemo(() => {
    const grouped = new Map<string, ToolActivity[]>();
    for (const row of data.toolCalls) {
      const activity = toActivity(row);
      const list = grouped.get(row.messageId);
      if (list) list.push(activity);
      else grouped.set(row.messageId, [activity]);
    }
    return grouped;
  }, [data.toolCalls]);

  // Associate in raw order, then filter display rows before computing day headings.
  // Raw messages remain authoritative for retry, edit, branching and history.
  const visibleMessages = useMemo(
    () =>
      data.messages.filter(
        (message) =>
          message.role !== "system" && !questionResponses.hiddenMessageIds.has(message.id),
      ),
    [data.messages, questionResponses],
  );
  const hydrated = useHydrated();
  const stamps = useMemo(
    () => (hydrated ? buildMessageStamps(visibleMessages) : null),
    [hydrated, visibleMessages],
  );
  const answerStamps = useMemo(
    () =>
      hydrated
        ? buildMessageStamps(
            data.messages.filter((message) => questionResponses.hiddenMessageIds.has(message.id)),
          )
        : null,
    [hydrated, data.messages, questionResponses],
  );

  const compactionsByMessage = useMemo(() => {
    const grouped = new Map<string, CompactionActivity[]>();
    for (const row of data.compactionEvents) {
      const activity = toCompactionActivity(row);
      const list = grouped.get(row.messageId);
      if (list) list.push(activity);
      else grouped.set(row.messageId, [activity]);
    }
    return grouped;
  }, [data.compactionEvents]);

  // messageId -> id of the next assistant message after it, in one pass.
  const nextAssistantAfter = useMemo(() => {
    const next = new Map<string, string>();
    for (let i = data.messages.length - 1; i >= 0; i--) {
      const message = data.messages[i]!;
      const following = data.messages[i + 1];
      const inherited = following ? next.get(following.id) : undefined;
      const value = following?.role === "assistant" ? following.id : inherited;
      if (value !== undefined) next.set(message.id, value);
    }
    return next;
  }, [data.messages]);

  const openEdit = useCallback(
    (messageId: string) => {
      setEditingMessageId(messageId);
      // Seeded as existing/claimed: removing one only drops it from the
      // replacement set, it is released by the save itself.
      if (!questionResponses.hiddenMessageIds.has(messageId)) {
        seedEditUploads(attachmentsByMessage.get(messageId) ?? []);
      }
    },
    [attachmentsByMessage, seedEditUploads, questionResponses],
  );

  const closeEdit = useCallback(() => {
    setEditingMessageId(null);
    // Structured edits have no upload lifecycle of their own.
    if (!editingMessageId || !questionResponses.hiddenMessageIds.has(editingMessageId))
      resetEditUploads();
  }, [resetEditUploads, editingMessageId, questionResponses]);

  // Which model wrote each answer — null once its row is gone. The retry menu
  // marks it, and a retry that omits a model reuses it server-side.
  const modelByMessage = useMemo(
    () => new Map(data.messages.map((m) => [m.id, m.modelId])),
    [data.messages],
  );

  const confirmEdit = useCallback(
    async (messageId: string) => {
      const messageIndex = data.messages.findIndex((message) => message.id === messageId);
      const after = data.messages.slice(messageIndex + 1);
      const responseIndex = after.findIndex((message) => message.role === "assistant");
      const removesLaterTurns =
        responseIndex === -1 ? after.length > 0 : after.slice(responseIndex + 1).length > 0;
      return (
        !removesLaterTurns ||
        (await confirm({
          title: "Edit this message?",
          description: "All messages after its response will be removed.",
          confirmLabel: "Save and regenerate",
        }))
      );
    },
    [data.messages, confirm],
  );

  const saveQuestionEdit = useCallback(
    async (questionResponse: QuestionResponse) => {
      if (
        !activeEditingMessage ||
        !questionResponses.hiddenMessageIds.has(activeEditingMessage.id) ||
        !effectiveModelId ||
        editPending ||
        questionNeedsRefresh ||
        generating
      )
        return false;
      if (!(await confirmEdit(activeEditingMessage.id))) return false;
      await mutateQuestionEdit({
        messageId: activeEditingMessage.id,
        questionResponse,
        modelId: effectiveModelId,
        searchEnabled,
        attachmentIds: [],
      });
      return true;
    },
    [
      activeEditingMessage,
      questionResponses,
      effectiveModelId,
      editPending,
      questionNeedsRefresh,
      generating,
      confirmEdit,
      mutateQuestionEdit,
      searchEnabled,
    ],
  );

  const saveEdit = useCallback(
    async (draft: string) => {
      if (!activeEditingMessage) return;
      const content = draft.trim();
      if (!effectiveModelId || editPending) return;
      if (!content && editUploadCount === 0) return;

      if (!(await confirmEdit(activeEditingMessage.id))) return;

      // Queues behind any upload still in flight, then sends the full ordered
      // replacement set — omitted ids are released server-side.
      submitEditUploads((attachmentIds) => {
        if (!content && attachmentIds.length === 0) return;
        mutateEdit({
          messageId: activeEditingMessage.id,
          content,
          modelId: effectiveModelId,
          searchEnabled,
          attachmentIds,
        });
      });
    },
    [
      activeEditingMessage,
      confirmEdit,
      editPending,
      editUploadCount,
      effectiveModelId,
      mutateEdit,
      searchEnabled,
      submitEditUploads,
    ],
  );

  // Durable rows change only with query data or global action availability. Live
  // stream and edit state are layered below so every unrelated row keeps its
  // object identity across stream chunks and local editor updates.
  const agentByMessage = useMemo(
    () =>
      new Map(
        (data.generations ?? []).flatMap((row) =>
          row.agent ? [[row.messageId, row.agent] as const] : [],
        ),
      ),
    [data.generations],
  );
  // Collections belong to the turn that added them: the user message directly
  // before each answer. That is where the composer showed them, so that is
  // where they stay.
  const collectionsByUserMessage = useMemo(() => {
    const byAssistant = new Map(
      (data.generations ?? []).map((row) => [row.messageId, row.collectionIds] as const),
    );
    const result = new Map<string, ReadonlyArray<string>>();
    let previousUser: string | null = null;
    for (const message of data.messages) {
      if (message.role === "user") previousUser = message.id;
      else if (message.role === "assistant" && previousUser) {
        const ids = byAssistant.get(message.id);
        if (ids && ids.length > 0) result.set(previousUser, ids);
      }
    }
    return result;
  }, [data.generations, data.messages]);
  const skillsByUserMessage = useMemo(() => {
    const byAssistant = new Map(
      (data.generations ?? []).map((row) => [row.messageId, row.skills ?? []] as const),
    );
    const result = new Map<string, ReadonlyArray<{ id: string; name: string }>>();
    let previousUser: string | null = null;
    for (const message of data.messages) {
      if (message.role === "user") previousUser = message.id;
      else if (message.role === "assistant" && previousUser) {
        const skills = byAssistant.get(message.id);
        if (skills?.length) result.set(previousUser, skills);
      }
    }
    return result;
  }, [data.generations, data.messages]);
  const baseDisplay = useMemo(() => {
    // Citation numbering is conversation-scoped: each message inherits every
    // source discovered before it, deduplicated by index and message order.
    const inheritedByIndex = new Map<number, ToolSource>();

    return visibleMessages.map((message): DisplayMessage => {
      const reasoning = message.reasoning ?? "";
      const toolActivities = toolCallsByMessage.get(message.id) ?? [];
      const compactionActivities = compactionsByMessage.get(message.id) ?? [];
      const retryTarget =
        message.role === "assistant" ? message.id : nextAssistantAfter.get(message.id);
      const inheritedSources = [...inheritedByIndex.values()];
      for (const source of collectSources(toolActivities)) {
        inheritedByIndex.set(source.index, mergeSource(inheritedByIndex.get(source.index), source));
      }
      const stamp = stamps?.get(message.id);
      const resolution = questionResponses.byAssistant.get(message.id);
      const answerTime = resolution ? answerStamps?.get(resolution.messageId) : undefined;
      const canRespond =
        message.role === "assistant" &&
        message.status === "complete" &&
        message.id === tailMessageId;

      return {
        ...message,
        error: message.error?.message ?? null,
        ...(stamp
          ? {
              dayLabel: stamp.dayLabel,
              time: { iso: stamp.iso, clock: stamp.clock, absolute: stamp.absolute },
            }
          : {}),
        reasoning,
        images: message.assistantOutput?.images ?? [],
        reasoningSeen: reasoning.length > 0,
        toolActivities,
        inheritedSources,
        compactionActivities,
        ...(canRespond || resolution
          ? {
              questionActions: {
                ...(canRespond ? { onRespond: respondToQuestion } : {}),
                disabled: actionsDisabled || !effectiveModelId,
                ...(resolution
                  ? {
                      resolved: {
                        ...resolution,
                        ...(answerTime ? { time: answerTime } : {}),
                        onEdit: () => openEdit(resolution.messageId),
                        editDisabled: actionsDisabled,
                      },
                    }
                  : {}),
              },
            }
          : {}),
        ...(attachmentsByMessage.has(message.id)
          ? { attachments: attachmentsByMessage.get(message.id)! }
          : {}),
        ...(agentByMessage.has(message.id) ? { agent: agentByMessage.get(message.id)! } : {}),
        ...(skillsByUserMessage.has(message.id)
          ? { skills: skillsByUserMessage.get(message.id)! }
          : {}),
        ...(collectionsByUserMessage.has(message.id)
          ? { collectionIds: collectionsByUserMessage.get(message.id)! }
          : {}),
        ...(message.role === "user" && message.status === "complete"
          ? {
              onEdit: () => openEdit(message.id),
              editDisabled: actionsDisabled,
            }
          : {}),
        // Only the answer itself can be forked, and only once it is finished —
        // the server insists on the same, this just keeps the row honest.
        ...(message.role === "assistant" && message.status !== "streaming"
          ? {
              onBranch: () => branchAt(message.id),
              branchDisabled: actionsDisabled,
            }
          : {}),
        ...(retryTarget !== undefined
          ? {
              onRetry: () => void retry(retryTarget),
              onRetryWith: (pickedModelId: string) => void retry(retryTarget, pickedModelId),
              retryModelId: modelByMessage.get(retryTarget) ?? null,
              retryDisabled: actionsDisabled,
            }
          : {}),
      };
    });
  }, [
    actionsDisabled,
    agentByMessage,
    collectionsByUserMessage,
    skillsByUserMessage,
    answerStamps,
    questionResponses,
    attachmentsByMessage,
    branchAt,
    compactionsByMessage,
    effectiveModelId,
    respondToQuestion,
    tailMessageId,
    modelByMessage,
    nextAssistantAfter,
    openEdit,
    retry,
    stamps,
    toolCallsByMessage,
    visibleMessages,
  ]);

  const liveId = streamingMessage?.id ?? (stream.status === "streaming" ? overlayId : null);
  const display = useMemo(
    () =>
      baseDisplay.map((base): DisplayMessage => {
        let projected = base;
        const resolved = base.questionActions?.resolved;
        if (resolved && activeEditingMessage?.id === resolved.messageId) {
          projected = {
            ...projected,
            questionActions: {
              ...base.questionActions,
              resolved: {
                ...resolved,
                editState: {
                  onSave: saveQuestionEdit,
                  onCancel: closeEdit,
                  disabled: mutationPending || generating || !effectiveModelId,
                },
              },
            },
          };
        }

        if (activeEditingMessage?.id === base.id) {
          projected = {
            ...projected,
            editState: {
              initialDraft: activeEditingMessage.content,
              researchEnabled: activeEditingMessage.generationMode === "research",
              onSave: (draft) => void saveEdit(draft),
              onCancel: closeEdit,
              saveDisabled: editPending,
              controlsDisabled: editPending,
              modelId: effectiveModelId,
              onModelChange: setModelId,
              searchEnabled,
              onSearchEnabledChange: setSearchEnabled,
              attachments: editUploads,
            },
          };
        }

        if (base.id !== liveId) return projected;

        // Overlay live stream state onto only the active assistant row.
        const live = {
          ...projected,
          images: stream.images,
          rawTextLength: stream.rawTextLength,
          reasoning: stream.reasoning,
          reasoningSeen: stream.reasoningSeen || base.reasoningSeen,
          toolActivities: stream.tools.length > 0 ? stream.tools : base.toolActivities,
          compactionActivities: stream.compactions,
        };
        // Status comes from the stream, not the row: the refetched row says
        // complete while the last words are still landing.
        if (stream.status === "streaming") {
          return { ...live, content: stream.text, status: "streaming" };
        }
        if (stream.text.length > base.content.length) {
          return { ...live, content: stream.text, status: stream.status };
        }
        return live;
      }),
    [
      activeEditingMessage,
      baseDisplay,
      closeEdit,
      editPending,
      editUploads,
      effectiveModelId,
      liveId,
      mutationPending,
      generating,
      saveQuestionEdit,
      saveEdit,
      searchEnabled,
      setSearchEnabled,
      stream.compactions,
      stream.rawTextLength,
      stream.reasoning,
      stream.reasoningSeen,
      stream.status,
      stream.text,
      stream.tools,
    ],
  );

  return (
    <div className="flex h-full flex-col">
      {data.branchedFrom ? (
        // Outside the scroller, on the message column's geometry: lineage is a
        // property of the conversation, not of its first message.
        <div className="[scrollbar-gutter:stable_both-edges]">
          <div className="text-muted-foreground mx-auto flex w-full max-w-3xl items-center gap-1.5 px-4 pb-2 pt-1 text-xs">
            <HugeiconsIcon icon={GitBranchIcon} strokeWidth={2} className="size-3.5 shrink-0" />
            <span className="shrink-0">Branched from</span>
            <Link
              to="/chat/$conversationId"
              params={{ conversationId: data.branchedFrom.conversationId }}
              className="hover:text-foreground min-w-0 truncate underline underline-offset-2"
            >
              {data.branchedFrom.title ?? "New chat…"}
            </Link>
          </div>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {/* lastSeq covers tool-activity-only updates too */}
        <ResearchPanelOwner messages={display} />
        <VirtualMessageList messages={display} followKey={stream.lastSeq} />
      </div>
      {/* Mirrors the message column (scrollbar gutter + max-w + px) so the
          composer edges align exactly with message content above. No top
          padding: the scroller's fade mask handles the visual transition. */}
      <div className="pb-4 [scrollbar-gutter:stable_both-edges]">
        <div className="mx-auto w-full max-w-3xl px-4">
          {questionNeedsRefresh ? (
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs" role="alert">
              <span>Refresh the chat to check whether your answers were sent.</span>
              <PendingButton
                size="sm"
                variant="outline"
                pending={refreshQuestionMutation.isPending}
                onClick={() => refreshQuestionMutation.mutate()}
              >
                Refresh chat
              </PendingButton>
            </div>
          ) : null}
          <Composer
            ref={composer}
            onSend={(content, attachmentIds, generationMode, skillIds) =>
              sendMutation.mutateAsync({
                content,
                attachmentIds,
                ...(generationMode ? { generationMode } : {}),
                ...(skillIds ? { skillIds } : {}),
              })
            }
            {...(stoppableId
              ? {
                  onStop: () =>
                    stopMutation.mutate({
                      messageId: stoppableId,
                      ...(streamingMessage?.generationId
                        ? { generationId: streamingMessage.generationId }
                        : {}),
                      ...(streamingMessage?.researchRunId
                        ? { researchRunId: streamingMessage.researchRunId }
                        : {}),
                    }),
                }
              : {})}
            disabled={actionsDisabled}
            textareaDisabled={activeEditingMessage !== null && (!editingAnswers || editPending)}
            controlsDisabled={mutationPending}
            modelId={effectiveModelId}
            onModelChange={setModelId}
            searchEnabled={searchEnabled}
            onSearchEnabledChange={setSearchEnabled}
            context={context}
          />
        </div>
      </div>
    </div>
  );
}

// How long the composer takes to travel from the middle of the column down to
// the bottom. Navigation waits this out, so a fast first response cannot swap
// the route in mid-slide — which would read as a jump rather than a move.
const SLIDE_MS = 380;

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);

export function NewChatView({
  user,
  initialAgentId = null,
  initialSkillId = null,
}: {
  user: { name: string };
  /** Pre-selected from an agent page; sent as an explicit install. */
  initialAgentId?: string | null;
  initialSkillId?: string | null;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [modelId, setModelId] = useState<string | null>(null);
  const { enabled: searchEnabled, setEnabled: setSearchEnabled } = useSearchMode();
  const context = useContextSelection({
    mode: "draft",
    agent: initialAgentId ? { id: initialAgentId, name: null } : null,
  });
  const selectedAgentId = context.selection.agent?.id ?? null;
  const selectedAgent = context.detail;
  const preferredModelApplied = useRef<string | null>(null);
  const modelOverride = useRef<string | null>(null);
  const searchOverride = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedAgentId) {
      preferredModelApplied.current = null;
      return;
    }
    if (!selectedAgent.data || preferredModelApplied.current === selectedAgentId) return;
    preferredModelApplied.current = selectedAgentId;
    if (searchOverride.current !== selectedAgentId)
      setSearchEnabled(selectedAgent.data.searchEnabled);
    if (modelOverride.current !== selectedAgentId && selectedAgent.data.model?.available)
      setModelId(selectedAgent.data.model.id);
  }, [selectedAgentId, selectedAgent.data, setSearchEnabled]);
  const starters = selectedAgent.data?.starters ?? [];
  const composer = useRef<ComposerHandle>(null);
  const isMobile = useIsMobile();
  useEffect(() => {
    if (!isMobile) composer.current?.focus();
  }, [isMobile]);
  // Flipped the moment the first message actually leaves: the composer drops
  // into the position it occupies in ChatView, so the route swap that follows
  // lands on geometry that already matches.
  const [sending, setSending] = useState(false);
  // Resolves when the slide is over. A ref because the mutation callbacks that
  // await it are created once, not per render.
  const slide = useRef<Promise<void>>(Promise.resolve());

  const sendMutation = useMutation({
    mutationFn: (input: {
      content: string;
      attachmentIds: ReadonlyArray<string>;
      generationMode?: GenerationMode;
      skillIds?: ReadonlyArray<string>;
    }) =>
      sendMessage({
        data: {
          conversationId: null,
          modelId: modelId!,
          content: input.content,
          searchEnabled,
          timeZone: browserTimeZone(),
          attachmentIds: input.attachmentIds,
          ...(input.generationMode ? { generationMode: input.generationMode } : {}),
          skillIds: [...(input.skillIds ?? [])],
          ...context.sendFields,
        },
      }),
    // Fires when the request starts, i.e. after any queued upload settled —
    // the composer should not move while it is still waiting on those.
    onMutate: () => {
      setSending(true);
      slide.current = prefersReducedMotion()
        ? Promise.resolve()
        : new Promise((resolve) => setTimeout(resolve, SLIDE_MS));
    },
    // The draft and its chips survive a failure, so the composer travels back
    // up to where the user left it.
    onError: () => setSending(false),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["conversations"] }),
        slide.current,
      ]);
      await navigate({
        to: "/chat/$conversationId",
        params: { conversationId: result.conversationId },
      });
    },
  });

  return (
    <div className="flex h-full flex-col">
      {/* Anchored to the bottom of its share of the column, so the greeting
          keeps its distance from the composer while both travel down. */}
      <div className="flex min-h-0 flex-1 flex-col justify-end px-4 pb-6">
        <div
          className={cn(
            "flex flex-col items-center text-center transition-all duration-200 ease-out motion-reduce:transition-none",
            sending ? "translate-y-1 opacity-0" : "translate-y-0 opacity-100",
          )}
        >
          {selectedAgent.data ? (
            // An agent chat announces itself: the agent, not the greeting,
            // is what the first message goes to.
            <>
              <span className="bg-muted text-muted-foreground mb-3 grid size-12 place-items-center rounded-2xl">
                <HugeiconsIcon
                  icon={agentIcon(selectedAgent.data.icon)}
                  strokeWidth={2}
                  className="size-6"
                  aria-hidden
                />
              </span>
              <h1 className="text-foreground text-2xl font-medium">{selectedAgent.data.name}</h1>
              {selectedAgent.data.description ? (
                <p className="text-muted-foreground mt-1 max-w-md text-sm">
                  {selectedAgent.data.description}
                </p>
              ) : null}
            </>
          ) : (
            <h1 className="text-muted-foreground text-2xl font-medium">{greetingFor(user.name)}</h1>
          )}
        </div>
        {starters.length > 0 && !sending ? (
          <ul
            aria-label="Conversation starters"
            className="mx-auto mt-6 flex w-full max-w-3xl flex-wrap justify-center gap-2"
          >
            {starters.map((starter) => (
              <li key={starter}>
                <Button
                  size="sm"
                  variant="outline"
                  className="max-w-72 rounded-3xl"
                  onClick={() => composer.current?.seedDraft(starter)}
                >
                  <span className="truncate">{starter}</span>
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {/* Mirrors ChatView's composer wrapper exactly — same scrollbar gutter,
          max width and bottom padding — so the slide ends on the next route's
          resting position instead of near it. */}
      <div className="pb-4 [scrollbar-gutter:stable_both-edges]">
        <div className="mx-auto w-full max-w-3xl px-4">
          <Composer
            initialSkillId={initialSkillId}
            onSend={(content, attachmentIds, generationMode, skillIds) =>
              sendMutation.mutateAsync({
                content,
                attachmentIds,
                ...(generationMode ? { generationMode } : {}),
                ...(skillIds ? { skillIds } : {}),
              })
            }
            disabled={sendMutation.isPending}
            modelId={modelId}
            onModelChange={(id, source) => {
              if (source !== "default") modelOverride.current = selectedAgentId;
              setModelId(id);
            }}
            searchEnabled={searchEnabled}
            onSearchEnabledChange={(enabled) => {
              searchOverride.current = selectedAgentId;
              setSearchEnabled(enabled);
            }}
            context={{
              ...context,
              onAgentChange: (id) => {
                preferredModelApplied.current = null;
                modelOverride.current = null;
                searchOverride.current = null;
                context.onAgentChange(id);
              },
            }}
            ref={composer}
          />
        </div>
      </div>
      {/* An equal share with the block above is what centres the composer;
          collapsing it to nothing is what carries the composer down.
          `flex-grow` is an animatable number, so this is one cheap property
          transition rather than a measured layout animation. */}
      <div
        className="min-h-0 basis-0 transition-[flex-grow] ease-in-out motion-reduce:transition-none"
        style={{ flexGrow: sending ? 0 : 1, transitionDuration: `${SLIDE_MS}ms` }}
      />
    </div>
  );
}
