import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { copyWorkspaceToBranch, desktopClient } from "~/modules/desktop/client/bridge.ts";
import type { useWorkGate } from "~/modules/desktop/client/use-work-gate.ts";
import type { WorkspaceImports } from "~/modules/desktop/client/use-workspace-imports.ts";
import type { AskTarget } from "~/modules/documents/ui/rich-editor/editor-hooks.ts";
import { flushBlockSaves } from "~/modules/genui/ui/pending-saves.ts";
import type { ReasoningEffort } from "~/modules/providers/model-config.ts";
import type { QuestionResponse } from "~/modules/tools/ask-user-schema.ts";
import { useConfirm } from "~/ui/confirm-context.ts";
import { toastError } from "~/ui/error-toast.ts";
import { browserTimeZone } from "../client/time-zone.ts";
import {
  activateWorkTurn,
  answerQuestion,
  branchConversation,
  editMessage,
  resumeMessage,
  retryMessage,
  sendMessage,
  stopGeneration,
} from "../server/functions.ts";
import type { ConversationData } from "./conversation-window.ts";
import type { associateQuestionResponses } from "./question-responses.ts";
import { lossSentence } from "./rewind-loss.ts";
import type { useChatArtifacts } from "./use-chat-artifacts.ts";
import type { useContextSelection } from "./use-context-selection.ts";
import type { useLiveAnswer } from "./use-live-answer.ts";
import type { useMessageEdit } from "./use-message-edit.ts";
import type { useReasoningEffort } from "./use-reasoning-effort.ts";
import type { useSearchMode } from "./use-search-mode.ts";
import { sendReservedWorkspaceTurn } from "./workspace-turn.ts";

/**
 * Every way this chat starts or ends an answer: send, answer a question,
 * retry, resume, edit, branch and stop, with what each saves and confirms
 * first and what their being in flight locks.
 */
export function useAttemptMutations({
  conversationId,
  data,
  dataUpdatedAt,
  live,
  edit,
  work,
  questionResponses,
  flushArtifacts,
  documentFocus,
  effectiveModelId,
  imagePick,
  searchEnabled,
  reasoningEffort,
  resetSearchEnabled,
  changeModel,
  context,
}: {
  conversationId: string;
  data: ConversationData;
  /** When the loaded conversation was last read. */
  dataUpdatedAt: number;
  live: ReturnType<typeof useLiveAnswer>;
  edit: ReturnType<typeof useMessageEdit>;
  work: ReturnType<typeof useWorkGate>;
  questionResponses: ReturnType<typeof associateQuestionResponses>;
  flushArtifacts: ReturnType<typeof useChatArtifacts>["flushArtifacts"];
  documentFocus: ReturnType<typeof useChatArtifacts>["documentFocus"];
  effectiveModelId: string | null;
  imagePick: { imageModelId?: string };
  searchEnabled: boolean;
  reasoningEffort: ReturnType<typeof useReasoningEffort>["effort"];
  resetSearchEnabled: ReturnType<typeof useSearchMode>["reset"];
  changeModel: (id: string) => void;
  context: ReturnType<typeof useContextSelection>;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { streamingMessage, stream, requestAnchor, cancelAnchor, releaseAnchor } = live;
  const {
    activeEditingMessage,
    editResearchEnabled,
    editUploads,
    submitEditUploads,
    beginEditSubmission,
    editUploadCount,
    editSkillIds,
    setEditSkillIds,
    editContext,
    settleEditContext,
    setEditingMessageId,
    closeEdit,
  } = edit;

  const checkWorkReady = () => work.check();
  /** What every way of starting an answer saves first, so it reads current drafts. */
  const flushPending = async () => {
    await flushBlockSaves();
    await flushArtifacts();
  };
  const prepareGeneration = async () => {
    checkWorkReady();
    await flushPending();
    closeEdit();
  };
  const beforeGeneration = async () => {
    await prepareGeneration();
    requestAnchor();
  };
  const sendMutation = useMutation({
    onMutate: beforeGeneration,
    onError: cancelAnchor,
    mutationFn: async (input: {
      content: string;
      attachmentIds: ReadonlyArray<string>;
      researchEnabled: boolean;
      skillIds?: ReadonlyArray<string>;
      workspaceFiles?: ReadonlyArray<string>;
      workspaceImports?: WorkspaceImports;
      /** Where in a document the request was made, instead of the editor's selection at send. */
      asked?: AskTarget & { documentId: string };
    }) => {
      const conversation = { kind: "existing" as const, id: conversationId };
      const fields = {
        modelId: effectiveModelId!,
        ...imagePick,
        content: input.content,
        searchEnabled,
        reasoningEffort,
        timeZone: browserTimeZone(),
        ...documentFocus(input.asked),
        attachmentIds: input.attachmentIds,
        researchEnabled: input.researchEnabled,
        skillIds: [...(input.skillIds ?? [])],
        ...context.sendFields,
      };
      if (input.workspaceImports && input.workspaceFiles?.length)
        return sendReservedWorkspaceTurn({
          conversation,
          imports: input.workspaceImports,
          activate: async (reservationId, workspaceFiles) =>
            activateWorkTurn({
              data: {
                reservationId,
                conversation,
                ...fields,
                ...(await work.attemptFields()),
                workspaceFiles: [...workspaceFiles],
              },
            }),
        });
      return sendMessage({
        data: {
          conversation,
          ...fields,
          ...(await work.attemptFields()),
        },
      });
    },
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
    onError: (error) => toastError("Could not refresh the chat.", error),
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
      toast.error("Could not refresh the chat.");
    }
  };
  const answerMutation = useMutation({
    onMutate: beforeGeneration,
    mutationFn: async (input: { callId: string; response: QuestionResponse }) =>
      answerQuestion({
        data: {
          conversationId,
          ...input,
          modelId: effectiveModelId!,
          searchEnabled,
          reasoningEffort,
          // The composer's research toggle belongs to a send, and no other
          // surface offers it. An answer to a clarification still keeps the
          // offer: the server inherits it from the attempt that asked.
          researchEnabled: false,
          ...(await work.attemptFields()),
          timeZone: browserTimeZone(),
          ...documentFocus(),
        },
      }),
    onError: (error) => {
      cancelAnchor();
      toastError("Could not send your answers.", error);
    },
    onSettled: refreshQuestionState,
  });
  const mutateAnswer = answerMutation.mutateAsync;
  const answerInFlight = useRef(false);

  const retryMutation = useMutation({
    onMutate: beforeGeneration,
    onError: cancelAnchor,
    // `modelId` omitted regenerates with the model that answered before; an
    // explicit choice also selects the composer model once the retry succeeds.
    // The persisted conversation default and earlier messages keep theirs.
    mutationFn: async (input: { messageId: string; modelId?: string }) =>
      retryMessage({
        data: {
          conversationId,
          ...input,
          ...imagePick,
          ...(await work.attemptFields()),
          timeZone: browserTimeZone(),
          ...documentFocus(),
        },
      }),
    onSuccess: async (_result, input) => {
      if (input.modelId !== undefined) changeModel(input.modelId);
      await queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
    },
  });

  // Continues the last answer where it ended. The row keeps its chunks and
  // the new generation continues their sequence, so the subscription is
  // seeded from the refetched cursor, exactly as after a retry.
  const resumeMutation = useMutation({
    onMutate: async () => {
      await prepareGeneration();
      // The earlier answer is already on screen; follow its continuation instead
      // of keeping the question its first attempt anchored.
      cancelAnchor();
      releaseAnchor();
    },
    onError: (error) => {
      toastError("Could not resume the answer.", error);
    },
    mutationFn: async (input: { messageId: string; modelId?: string }) =>
      resumeMessage({
        data: {
          conversationId,
          ...input,
          ...(await work.attemptFields()),
          timeZone: browserTimeZone(),
          ...documentFocus(),
        },
      }),
    onSuccess: async (_result, input) => {
      if (input.modelId !== undefined) changeModel(input.modelId);
      await queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
    },
  });

  // Branching leaves this conversation untouched and opens the copy, so the
  // only cache work here is making the new chat show up in the lists.
  const branchMutation = useMutation({
    onMutate: async () => {
      await flushPending();
      closeEdit();
    },
    mutationFn: (messageId: string) => branchConversation({ data: { conversationId, messageId } }),
    onSuccess: async (result) => {
      // A work chat's local state is what makes the branch usable: grants and
      // workspace are copied before the view opens, so the destination's first
      // send cannot race its own lazy creation. Local and fast; a failure
      // opens the branch without its files rather than not opening it.
      if (data.conversation.mode === "work" && desktopClient()) {
        try {
          await copyWorkspaceToBranch(conversationId, result.conversationId);
        } catch {
          toast.error("The branch opened without its local files.");
        }
      }
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
      await navigate({
        to: "/chat/$conversationId",
        params: { conversationId: result.conversationId },
      });
    },
  });

  const stopMutation = useMutation({
    mutationFn: (input: { messageId: string; generationId?: string }) =>
      stopGeneration({ data: { conversationId, ...input } }),
    // No invalidation here: the generation finalizes itself and the `done`
    // event already carries the terminal status back through the stream hook.
    // A refused stop sends none, so it says so.
    onError: (error) => toastError("Could not stop the response.", error),
  });

  const editMutation = useMutation({
    onMutate: async () => {
      checkWorkReady();
      await flushPending();
      requestAnchor();
    },
    mutationFn: async (
      input: {
        messageId: string;
        modelId: string;
        searchEnabled: boolean;
        reasoningEffort?: ReasoningEffort | null;
        researchEnabled?: boolean;
        attachmentIds: ReadonlyArray<string>;
        releaseUploads?: () => void;
        skillIds?: ReadonlyArray<string>;
        collectionIds?: ReadonlyArray<string>;
      } & (
        | { content: string; questionResponse?: never }
        | { questionResponse: QuestionResponse; content?: never }
      ),
    ) => {
      const { releaseUploads: _releaseUploads, ...editFields } = input;
      return editMessage({
        data: {
          conversationId,
          ...(input.content !== undefined ? imagePick : {}),
          researchEnabled: false,
          ...editFields,
          ...(await work.attemptFields()),
          timeZone: browserTimeZone(),
          ...documentFocus(),
        },
      });
    },
    onSuccess: async (_result, input) => {
      if (input.questionResponse) {
        await refreshQuestionState();
      } else {
        // Claim before refreshing: a failed refresh cannot undo server acceptance.
        editUploads.markClaimed(input.attachmentIds);
        await queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
        setEditSkillIds([]);
        settleEditContext();
        resetSearchEnabled();
      }
      setEditingMessageId(null);
    },
    onError: async (_error, input) => {
      cancelAnchor();
      if (!input.questionResponse) return;
      toast.error("Could not save your answers.");
      await refreshQuestionState();
    },
    onSettled: (_result, _error, input) => input.releaseUploads?.(),
  });

  const mutateRetry = retryMutation.mutate;
  const mutateResume = resumeMutation.mutate;
  const mutateBranch = branchMutation.mutate;
  const mutateEdit = editMutation.mutate;
  const mutateQuestionEdit = editMutation.mutateAsync;
  const editPending = editMutation.isPending;

  // Retry rewinds the conversation to that response: retrying anything but
  // the last one deletes the messages after it, so it asks first.
  const lastAssistantId = [...data.messages].toReversed().find((m) => m.role === "assistant")?.id;
  const generating =
    sendMutation.isPending || answerMutation.isPending || stream.status === "streaming";
  // What may still be writing to a document: a row the server says is streaming,
  // or a generation this client just started. Deliberately not `generating`,
  // whose stream status stays "streaming" while the smoothed text drains long
  // after the answer is complete.
  const generationRequested =
    sendMutation.isPending ||
    answerMutation.isPending ||
    retryMutation.isPending ||
    resumeMutation.isPending ||
    editMutation.isPending;
  // The request settles before the refetch that reports the row it started, and
  // an unlocked frame in that gap flickers the panel. Hold from the request
  // until either the row appears or a later read proves there is none.
  const [awaitingGeneration, setAwaitingGeneration] = useState<number | null>(null);
  if (generationRequested && awaitingGeneration === null) setAwaitingGeneration(dataUpdatedAt);
  else if (
    !generationRequested &&
    awaitingGeneration !== null &&
    (streamingMessage !== undefined || dataUpdatedAt > awaitingGeneration)
  )
    setAwaitingGeneration(null);
  const mutationPending =
    answerMutation.isPending ||
    questionNeedsRefresh ||
    sendMutation.isPending ||
    retryMutation.isPending ||
    resumeMutation.isPending ||
    editMutation.isPending ||
    branchMutation.isPending;
  // An open edit locks nothing: its draft is local to the row, another message's
  // Edit switches to it, and the composer stays live. Only work already in flight
  // does, plus generating, which the server refuses to edit under anyway.
  const actionsDisabled =
    questionNeedsRefresh ||
    generating ||
    retryMutation.isPending ||
    resumeMutation.isPending ||
    editMutation.isPending ||
    branchMutation.isPending;
  // Generation actions (edit/retry/answer/save) wait on the folder; branch
  // copies history and must stay available in a browser.
  const generationDisabled = actionsDisabled || work.readOnly;
  const respondToQuestion = useCallback(
    async (callId: string, response: QuestionResponse) => {
      if (actionsDisabled || !effectiveModelId || answerInFlight.current) {
        throw new Error("Question response unavailable");
      }
      answerInFlight.current = true;
      return mutateAnswer({ callId, response }).finally(() => {
        answerInFlight.current = false;
      });
    },
    [actionsDisabled, effectiveModelId, mutateAnswer],
  );
  // Steers sit just after the answer they went into; "what came last" means
  // the last turn message, so questions on a steered answer stay answerable.
  const turnMessages = useMemo(
    () => data.messages.filter((message) => !message.steeredIntoMessageId),
    [data.messages],
  );
  const tailMessageId = turnMessages.at(-1)?.id;
  // A rewind takes the documents, drafts and unpublished files those answers
  // created with it, so the dialog names them: a checklist someone has been
  // ticking, or a deck someone has been building, is not a silent casualty.
  const documentLoss = useCallback(
    (fromMessageId: string, inclusive: boolean) => {
      const index = data.messages.findIndex((message) => message.id === fromMessageId);
      if (index < 0) return "";
      const removed = new Set(
        data.messages.slice(inclusive ? index : index + 1).map((message) => message.id),
      );
      const lost = <T extends { messageId: string | null }>(items: ReadonlyArray<T> | undefined) =>
        (items ?? []).filter((item) => item.messageId && removed.has(item.messageId));
      return lossSentence([
        ...lost(data.documents).map((document) => ({
          noun: "document",
          name: document.title,
        })),
        ...lost(data.agentDrafts).map((draft) => ({ noun: "agent draft", name: draft.name })),
        ...lost(data.scheduleDrafts).map((draft) => ({
          noun: "schedule draft",
          name: draft.name,
        })),
        ...lost(data.workingFiles).map((file) => ({ noun: "unpublished file", name: file.name })),
      ]);
    },
    [data.agentDrafts, data.documents, data.messages, data.scheduleDrafts, data.workingFiles],
  );

  // A steer goes with the answer it was sent into, and it is the person's own
  // text, so a rewind that replaces that answer says so first.
  const steerLoss = useCallback(
    (answerId: string | undefined) => {
      const count = data.messages.filter(
        (message) => answerId && message.steeredIntoMessageId === answerId,
      ).length;
      if (count === 0) return "";
      return count === 1
        ? " The message you steered into it will be removed too."
        : ` The ${count} messages you steered into it will be removed too.`;
    },
    [data.messages],
  );

  const retry = useCallback(
    async (messageId: string, pickedModelId?: string) => {
      const later = messageId !== lastAssistantId;
      const losing = documentLoss(messageId, true) + steerLoss(messageId);
      if (
        (later || losing) &&
        !(await confirm({
          title: "Retry this response?",
          description: `${later ? "All messages after it will be removed." : ""}${losing}`.trim(),
          confirmLabel: "Retry",
        }))
      ) {
        return;
      }
      mutateRetry(
        pickedModelId === undefined ? { messageId } : { messageId, modelId: pickedModelId },
      );
    },
    [confirm, documentLoss, lastAssistantId, mutateRetry, steerLoss],
  );
  const branchAt = useCallback((messageId: string) => mutateBranch(messageId), [mutateBranch]);

  const confirmEdit = useCallback(
    async (messageId: string) => {
      // Steers of the response go with it and are named on their own below.
      const messageIndex = turnMessages.findIndex((message) => message.id === messageId);
      const after = turnMessages.slice(messageIndex + 1);
      const responseIndex = after.findIndex((message) => message.role === "assistant");
      const removesLaterTurns =
        responseIndex === -1 ? after.length > 0 : after.slice(responseIndex + 1).length > 0;
      const losing = documentLoss(messageId, false) + steerLoss(after[responseIndex]?.id);
      return (
        (!removesLaterTurns && !losing) ||
        (await confirm({
          title: "Edit this message?",
          description:
            `${removesLaterTurns ? "All messages after its response will be removed." : ""}${losing}`.trim(),
          confirmLabel: "Save and regenerate",
        }))
      );
    },
    [confirm, documentLoss, steerLoss, turnMessages],
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
        reasoningEffort,
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
      reasoningEffort,
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
      // replacement set. Omitted ids are released server-side.
      submitEditUploads((attachmentIds) => {
        if (!content && attachmentIds.length === 0) return;
        mutateEdit({
          messageId: activeEditingMessage.id,
          content,
          modelId: effectiveModelId,
          searchEnabled,
          reasoningEffort,
          researchEnabled: editResearchEnabled,
          attachmentIds,
          releaseUploads: beginEditSubmission(attachmentIds),
          skillIds: editSkillIds,
          collectionIds: editContext.sendFields.collectionIds,
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
      reasoningEffort,
      editResearchEnabled,
      submitEditUploads,
      beginEditSubmission,
      editSkillIds,
      editContext,
    ],
  );

  return {
    checkWorkReady,
    flushPending,
    sendMutation,
    stopMutation,
    retryMutation,
    resumeMutation,
    editMutation,
    branchMutation,
    refreshQuestionMutation,
    questionNeedsRefresh,
    generating,
    mutationPending,
    actionsDisabled,
    generationDisabled,
    editPending,
    mutateResume,
    respondToQuestion,
    tailMessageId,
    retry,
    branchAt,
    saveEdit,
    saveQuestionEdit,
  };
}
