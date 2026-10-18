import { useChatIntegrations } from "~/modules/integrations/client/use-chat-integrations.ts";

import { AgentDraftOwner } from "~/modules/agents/ui/agent-draft-owner.tsx";
import { ScheduleDraftOwner } from "~/modules/schedules/ui/schedule-draft-owner.tsx";
import { DocumentOwner } from "~/modules/documents/ui/document-owner.tsx";
import type { AskTarget } from "~/modules/documents/ui/rich-editor/editor-hooks.ts";

import { ConversationCrumbs } from "./conversation-crumbs.tsx";

import { learnServerClock } from "../client/use-message-stream.ts";
import { lookupsOf, mergeLookups, NO_LOOKUPS } from "../assistant-output.ts";
import { collectSources } from "./citations.ts";
import { inheritSources } from "./inherited-sources.ts";

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { conversationHistoryQuery, conversationQuery } from "../client/queries.ts";
import { withHistory } from "./conversation-window.ts";

import { placeStranded, placed, shownIds } from "./stranded-cards.ts";
import { useChatArtifacts } from "./use-chat-artifacts.ts";
import { useLiveAnswer } from "./use-live-answer.ts";
import { useMessageEdit } from "./use-message-edit.ts";
import { useAttemptMutations } from "./use-attempt-mutations.ts";
import { browserTimeZone } from "../client/time-zone.ts";
import { type ToolActivity } from "../client/use-message-stream.ts";
import { lookupUiMap, saveUiState, updateWorkSettings } from "../server/functions.ts";
import type { PermissionLevel } from "../schema.ts";

import { Composer, type ComposerHandle } from "./composer.tsx";
import { useLocalMachineId } from "~/modules/desktop/client/bridge.ts";
import { WORKSPACE_FOLDER_NAME } from "@chat/desktop-rpc";
import { ForeignMachineBanner } from "~/modules/desktop/ui/foreign-machine-banner.tsx";
import { foreignMachineStamp } from "~/modules/desktop/ui/foreign-machine-stamp.ts";
import { useConversationQueue } from "./use-conversation-queue.ts";
import { createsDocument } from "./assistant-body.ts";
import { useWorkGate } from "~/modules/desktop/client/use-work-gate.ts";
import { LocalFileConversationProvider } from "~/modules/desktop/ui/local-file-preview.tsx";
import { FileReferenceContext } from "./file-reference-context.ts";
import type { Attachment } from "~/modules/attachments/schema.ts";
import { useWorkApprovals } from "~/modules/desktop/client/work-context.ts";
import { type ApprovalChoice } from "~/modules/desktop/client/approvals.ts";

import { associateQuestionResponses } from "./question-responses.ts";
import { buildMessageStamps } from "./timestamps.ts";
import { useMessageRows } from "./use-message-rows.ts";
import { ownsDocument } from "./use-discovered-artifacts.ts";
import { useSearchMode } from "./use-search-mode.ts";
import { useReasoningEffort } from "./use-reasoning-effort.ts";

import { useContextSelection } from "./use-context-selection.ts";
import type { DisplayMessage } from "./message-list.tsx";

import { VirtualMessageList } from "./virtual-message-list.tsx";
import { projectCan } from "~/modules/projects/schema.ts";
import { WritableChatProjectProvider } from "~/modules/projects/ui/save-to-project.tsx";
import { FileCommentContext } from "~/modules/attachments/ui/file-comment.ts";
import { ResearchPanelOwner } from "./research-panel-owner.tsx";
import { SourcesPanelOwner } from "./sources-panel-owner.tsx";
import { useMarkRead } from "./use-mark-read.ts";
import { useBrowserChat } from "~/modules/browser/client/use-browser-chat.ts";

import { PendingButton } from "~/ui/pending-button.tsx";

import { useIsMobile } from "~/ui/use-mobile.ts";
import { useDocumentTitle } from "~/ui/use-document-title.ts";

import { toastError } from "~/ui/error-toast.ts";
import {
  GenuiActionsContext,
  type UiMapLookup,
  type UiStateSave,
} from "~/modules/genui/ui/context.ts";

export function ChatView({
  conversationId,
  anchorFirstTurn = false,
}: {
  conversationId: string;
  /** Opened by the new-chat page right after sending, so the answer arriving is ours. */
  anchorFirstTurn?: boolean;
}) {
  const composer = useRef<ComposerHandle>(null);
  const isMobile = useIsMobile();
  // Opening a chat should leave the caret ready to type. Not on a phone: that
  // would raise the keyboard over the conversation the user came to read.
  useEffect(
    () => {
      if (!isMobile) composer.current?.focus();
    },
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- again for each chat opened
    [conversationId, isMobile],
  );
  const queryClient = useQueryClient();
  const { data: head, dataUpdatedAt } = useSuspenseQuery(conversationQuery(conversationId));
  // Older turns load only once the reader scrolls up to the first loaded one.
  // A new anchor (a rewind past the old one) starts that over.
  const [historyWanted, setHistoryWanted] = useState<string | null>(null);
  const history = useInfiniteQuery({
    ...conversationHistoryQuery(conversationId, head.window.anchorId, head.window.olderCursor),
    enabled: head.window.olderCursor !== null && historyWanted === head.window.anchorId,
  });
  const data = useMemo(() => withHistory(head, history.data?.pages), [head, history.data]);
  // The snapshot's times are the server's; running timers read them against its clock.
  useEffect(() => {
    if (head.serverTime) learnServerClock(head.serverTime, dataUpdatedAt);
  }, [head.serverTime, dataUpdatedAt]);
  useBrowserChat(conversationId, data.conversation.temporary);
  useMarkRead(conversationId, data.conversation.unread);
  const { hasNextPage, isFetching: loadingOlder, fetchNextPage } = history;
  const loadOlder = useCallback(() => {
    if (!data.hasOlder || loadingOlder) return;
    if (historyWanted !== head.window.anchorId) setHistoryWanted(head.window.anchorId);
    else if (hasNextPage) void fetchNextPage();
  }, [
    data.hasOlder,
    fetchNextPage,
    hasNextPage,
    head.window.anchorId,
    historyWanted,
    loadingOlder,
  ]);
  // Stays in step with an asynchronously generated title: `conversation.updated`
  // invalidates this query, so the tab renames itself when the title lands.
  useDocumentTitle(data.conversation.title);
  const [modelId, setModelId] = useState<string | null>(null);
  // A pick in this view; the chat's own lock shows until one is made.
  const [imageModelId, setImageModelId] = useState<string | null>(null);
  const imagePick = imageModelId ? { imageModelId } : {};
  // One folder state for the strip and the send, so attaching in the strip is
  // what the very next message reports. A plain chat never offers the tools.
  const work = useWorkGate(conversationId, data.conversation.mode === "work");
  const folder = work.folder;
  const localMachineId = useLocalMachineId();
  const foreignMachine =
    data.conversation.mode === "work"
      ? foreignMachineStamp(
          conversationId,
          localMachineId,
          // Found server-side: the newest such attempt may predate the loaded turns.
          data.latestMachineAttempt ? [data.latestMachineAttempt] : [],
          data.latestMachineAttempt ? [data.latestMachineAttempt.messageId] : [],
        )
      : null;

  const liveAnswer = useLiveAnswer({ data, conversationId, anchorFirstTurn });
  const { streamingMessage, stream, liveId, anchorId, releaseAnchor } = liveAnswer;
  const {
    agentDraft,
    scheduleDraft,
    documents,
    draftIds,
    scheduleDraftIds,
    documentIds,
    scopedForgottenDocuments,
    forgetDraft,
    forgetDocument,
    liveCreated,
    documentFocus,
    flushArtifacts,
  } = useChatArtifacts({
    data,
    conversationId,
    tools: stream.tools,
    streamingId: streamingMessage?.id,
    isMobile,
  });

  const desktopApprovals = useWorkApprovals(conversationId);
  const workSettingsMutation = useMutation({
    mutationFn: (permissionLevel: PermissionLevel) =>
      updateWorkSettings({ data: { conversationId, permissionLevel } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] }),
    onError: (error) => toastError("Could not change the approval level.", error),
  });
  // Handed to every message; the card is found by call id, so only the message
  // holding that call renders one.
  const desktopApprovalRequests = useMemo(
    () =>
      new Map(
        [...desktopApprovals.pending].map(([callId, kind]) => [
          callId,
          {
            kind,
            args: desktopApprovals.args(callId),
            decide: (choice: ApprovalChoice) => desktopApprovals.decide(callId, choice),
          },
        ]),
      ),
    [desktopApprovals],
  );
  const questionResponses = useMemo(
    () => associateQuestionResponses(data.messages, data.toolCalls, data.attachments),
    [data.messages, data.toolCalls, data.attachments],
  );
  const effectiveModelId = modelId ?? data.conversation.modelId;
  const { effort: reasoningEffort, setEffort: setReasoningEffort } =
    useReasoningEffort(effectiveModelId);
  const changeModel = useCallback(
    (id: string) => {
      if (id !== effectiveModelId) setReasoningEffort(null);
      setModelId(id);
    },
    [effectiveModelId, setReasoningEffort],
  );
  const {
    enabled: searchEnabled,
    preferred: searchPreference,
    setEnabled: setSearchEnabled,
    reset: resetSearchEnabled,
  } = useSearchMode(data.agent?.searchEnabled ?? true);
  const context = useContextSelection({ mode: "installed", agent: data.agent });
  const integrations = useChatIntegrations(conversationId);
  const {
    machinesByMessage,
    attachmentsByMessage,
    steersByAnswer,
    uiStatesByMessage,
    toolCallsByMessage,
    compactionsByMessage,
    nextAssistantAfter,
    modelByMessage,
    collectionsByUserMessage,
    skillsByUserMessage,
    workspaceFilesByUserMessage,
  } = useMessageRows(data);
  const messageEdit = useMessageEdit({
    data,
    questionResponses,
    attachmentsByMessage,
    skillsByUserMessage,
    collectionsByUserMessage,
  });
  const {
    activeEditingMessage,
    editResearchEnabled,
    setEditResearchEnabled,
    editUploads,
    editSkillIds,
    setEditSkillIds,
    editContext,
    editableSkills,
    closeEdit,
    openEdit,
  } = messageEdit;
  const {
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
  } = useAttemptMutations({
    conversationId,
    data,
    dataUpdatedAt,
    live: liveAnswer,
    edit: messageEdit,
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
  });

  const sendAsk = sendMutation.mutateAsync;
  const focusComposer = useCallback(() => composer.current?.focus(), []);
  // A request typed inside a document: sent like the composer's, with the spot selected.
  const askFromDocument = useCallback(
    async (request: string, asked: AskTarget & { documentId: string }) => {
      if (generationDisabled) return false;
      await sendAsk({
        content: request,
        attachmentIds: [],
        researchEnabled: false,
        skillIds: [],
        asked,
      });
      return true;
    },
    [generationDisabled, sendAsk],
  );
  // A comment on a file the messages show: sent like the composer's, with nothing selected.
  const askAboutFile = useRef<(message: string) => Promise<boolean>>(async () => false);
  useEffect(() => {
    askAboutFile.current = async (message) => {
      if (generationDisabled) return false;
      await sendAsk({ content: message, attachmentIds: [], researchEnabled: false, skillIds: [] });
      return true;
    };
  }, [generationDisabled, sendAsk]);
  // Stable, so a panel tab opened with it sends under the chat's state when used, not when opened.
  const sendFileComment = useCallback((message: string) => askAboutFile.current(message), []);
  // What ```ui blocks may do here: suggestions go out as ordinary sends,
  // anything else waits in the composer, and state saves are best effort.
  const mutateSend = sendMutation.mutate;
  const genuiActions = useMemo(
    () => ({
      tailId: tailMessageId,
      disabled: generationDisabled,
      send: (text: string) =>
        mutateSend({ content: text, attachmentIds: [], researchEnabled: false, skillIds: [] }),
      offer: (text: string) => composer.current?.offerDraft(text),
      save: (input: UiStateSave) =>
        saveUiState({ data: input }).then(
          () => {},
          () => {},
        ),
      lookupMap: (input: UiMapLookup) =>
        lookupUiMap({ data: input }).then(
          (result) => result,
          () => ({ lookups: null, busy: false }),
        ),
    }),
    [tailMessageId, generationDisabled, mutateSend],
  );

  // Only offered for a generation this client can actually see running.
  const stoppableId = stream.status === "streaming" ? streamingMessage?.id : undefined;

  const conversationQueue = useConversationQueue({
    conversationId,
    mode: data.conversation.mode,
    rows: data.queue,
    state: data.queueState,
    running:
      streamingMessage?.generationId != null
        ? { messageId: streamingMessage.id, generationId: streamingMessage.generationId }
        : null,
    arrived: stream.steers,
    // What a send carries now; a queued message freezes it.
    submission: async () => ({
      modelId: effectiveModelId!,
      ...imagePick,
      searchEnabled,
      reasoningEffort,
      ...(await work.attemptFields()),
      timeZone: browserTimeZone(),
      ...documentFocus(),
      ...context.sendFields,
    }),
    attemptFields: () => work.attemptFields(),
    checkWork: checkWorkReady,
    prepare: async () => {
      checkWorkReady();
      await flushPending();
    },
    settings: {
      modelId,
      setModelId,
      imageModelId,
      setImageModelId,
      reasoningEffort,
      setReasoningEffort,
      searchPreference,
      setSearchEnabled,
      resetSearchEnabled,
      collectionIds: context.sendFields.collectionIds,
      seedCollections: context.seed,
      settleCollections: context.settle,
    },
  });

  // Associate in raw order, then filter display rows before computing day headings.
  // Raw messages remain authoritative for retry, edit, branching and history.
  const visibleMessages = useMemo(
    () =>
      data.messages.filter(
        (message) =>
          message.role !== "system" &&
          !message.steeredIntoMessageId &&
          !questionResponses.hiddenMessageIds.has(message.id),
      ),
    [data.messages, questionResponses],
  );
  const stamps = useMemo(() => buildMessageStamps(visibleMessages), [visibleMessages]);
  const answerStamps = useMemo(
    () =>
      buildMessageStamps(
        data.messages.filter((message) => questionResponses.hiddenMessageIds.has(message.id)),
      ),
    [data.messages, questionResponses],
  );

  // Durable rows change only with query data or global action availability. Live
  // stream and edit state are layered below so every unrelated row keeps its
  // object identity across stream chunks and local editor updates.

  // The server keeps root names only, so display resolves them against this
  // machine's live workspace and grants. Unresolved names drop out; grouping
  // then falls back to the path's first segment.
  const desktopRootsByMessage = useMemo(() => {
    if (data.conversation.mode !== "work") return new Map<string, never>();
    const workspacePath =
      folder?.readiness === "ready" ? (folder.status.workspace?.path ?? null) : null;
    const grants =
      folder?.readiness === "ready" ? folder.status.folders.filter((item) => item.alive) : [];
    const result = new Map<string, ReadonlyArray<{ name: string; path: string }>>();
    for (const row of data.generations ?? []) {
      const names = row.desktopRoots ?? [];
      const roots = names.flatMap((name) => {
        if (name === WORKSPACE_FOLDER_NAME)
          return workspacePath ? [{ name, path: workspacePath }] : [];
        const grant = grants.find((item) => item.name === name);
        return grant ? [{ name, path: grant.path }] : [];
      });
      if (roots.length > 0) result.set(row.messageId, roots);
    }
    return result;
  }, [data.generations, data.conversation.mode, folder]);
  const baseDisplay = useMemo(() => {
    const inherited = inheritSources(
      visibleMessages.map((message) => collectSources(toolCallsByMessage.get(message.id) ?? [])),
      data.priorSources,
    );

    return visibleMessages.map((message, position): DisplayMessage => {
      const reasoning = message.reasoning ?? "";
      const toolActivities = toolCallsByMessage.get(message.id) ?? [];
      const compactionActivities = compactionsByMessage.get(message.id) ?? [];
      const retryTarget =
        message.role === "assistant" ? message.id : nextAssistantAfter.get(message.id);
      const inheritedSources = inherited[position]!;
      const stamp = stamps.get(message.id);
      const resolution = questionResponses.byAssistant.get(message.id);
      const answerTime = resolution ? answerStamps.get(resolution.messageId) : undefined;
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
        files: message.assistantOutput?.files ?? [],
        uiLookups: lookupsOf(message.assistantOutput),
        temporary: data.conversation.temporary,
        ...(uiStatesByMessage.has(message.id)
          ? { uiStates: uiStatesByMessage.get(message.id)! }
          : {}),
        desktopMachineId: machinesByMessage.get(message.id) ?? null,
        reasoningSeen: reasoning.length > 0,
        toolActivities,
        inheritedSources,
        compactionActivities,
        ...(steersByAnswer.has(message.id) ? { steers: steersByAnswer.get(message.id)! } : {}),
        ...(canRespond || resolution
          ? {
              questionActions: {
                ...(canRespond ? { onRespond: respondToQuestion } : {}),
                disabled: generationDisabled || !effectiveModelId,
                ...(resolution
                  ? {
                      resolved: {
                        ...resolution,
                        ...(answerTime ? { time: answerTime } : {}),
                        onEdit: () => openEdit(resolution.messageId),
                        editDisabled: generationDisabled,
                      },
                    }
                  : {}),
              },
            }
          : {}),
        ...(desktopApprovalRequests.size > 0 ? { desktopApprovals: desktopApprovalRequests } : {}),
        ...(desktopRootsByMessage.has(message.id)
          ? { desktopRoots: desktopRootsByMessage.get(message.id)! }
          : {}),
        ...(attachmentsByMessage.has(message.id)
          ? { attachments: attachmentsByMessage.get(message.id)! }
          : {}),
        ...(skillsByUserMessage.has(message.id)
          ? { skills: skillsByUserMessage.get(message.id)! }
          : {}),
        ...(collectionsByUserMessage.has(message.id)
          ? { collectionIds: collectionsByUserMessage.get(message.id)! }
          : {}),
        ...(workspaceFilesByUserMessage.has(message.id)
          ? { workspaceFiles: workspaceFilesByUserMessage.get(message.id)! }
          : {}),
        ...(message.role === "user" && message.status === "complete"
          ? {
              onEdit: () => openEdit(message.id),
              editDisabled: generationDisabled,
            }
          : {}),
        // Only the answer itself can be forked, and only once it is finished.
        // The server insists on the same, this just keeps the row honest.
        ...(message.role === "assistant" && message.status !== "streaming"
          ? {
              onBranch: () => branchAt(message.id),
              branchDisabled: actionsDisabled,
            }
          : {}),
        // Only the last answer can continue: a later turn was already
        // answered without whatever it would go on to say.
        ...(message.role === "assistant" &&
        (message.status === "error" || message.status === "aborted") &&
        message.id === tailMessageId
          ? {
              onResume: () => mutateResume({ messageId: message.id }),
              onResumeWith: (pickedModelId: string) =>
                mutateResume({ messageId: message.id, modelId: pickedModelId }),
            }
          : {}),
        ...(retryTarget !== undefined
          ? {
              onRetry: () => void retry(retryTarget),
              onRetryWith: (pickedModelId: string) => void retry(retryTarget, pickedModelId),
              retryModelId: modelByMessage.get(retryTarget) ?? null,
              retryDisabled: generationDisabled,
            }
          : {}),
      };
    });
  }, [
    actionsDisabled,
    collectionsByUserMessage,
    skillsByUserMessage,
    workspaceFilesByUserMessage,
    desktopRootsByMessage,
    machinesByMessage,
    answerStamps,
    questionResponses,
    attachmentsByMessage,
    branchAt,
    compactionsByMessage,
    desktopApprovalRequests,
    generationDisabled,
    effectiveModelId,
    respondToQuestion,
    tailMessageId,
    modelByMessage,
    mutateResume,
    nextAssistantAfter,
    openEdit,
    retry,
    stamps,
    steersByAnswer,
    toolCallsByMessage,
    uiStatesByMessage,
    data.conversation.temporary,
    visibleMessages,
    data.priorSources,
  ]);

  const display = useMemo(() => {
    const edit: RowEdit | null = activeEditingMessage
      ? {
          messageId: activeEditingMessage.id,
          question: {
            onSave: saveQuestionEdit,
            onCancel: closeEdit,
            disabled: generationDisabled || !effectiveModelId,
          },
          message: {
            initialDraft: activeEditingMessage.content,
            researchEnabled: editResearchEnabled,
            onResearchEnabledChange: setEditResearchEnabled,
            onSave: (draft) => void saveEdit(draft),
            onCancel: closeEdit,
            saveDisabled: editPending || work.readOnly,
            controlsDisabled: editPending,
            modelId: effectiveModelId,
            onModelChange: changeModel,
            searchEnabled,
            onSearchEnabledChange: setSearchEnabled,
            reasoningEffort,
            onReasoningEffortChange: setReasoningEffort,
            attachments: editUploads,
            skills: {
              items: editableSkills.data ?? [],
              selectedIds: editSkillIds,
              onChange: setEditSkillIds,
            },
            context: editContext,
          },
        }
      : null;
    const live: LiveRow | null = liveId
      ? {
          messageId: liveId,
          files: stream.files,
          tools: stream.tools,
          compactions: stream.compactions,
          steers: stream.steers,
          text: stream.live,
          status: stream.status,
          reading: stream.reading,
          lookups: stream.lookups,
          previews: stream.previews,
        }
      : null;
    return baseDisplay.map((base) => projectRow(base, edit, live));
  }, [
    activeEditingMessage,
    baseDisplay,
    changeModel,
    closeEdit,
    editPending,
    editUploads,
    effectiveModelId,
    liveId,
    generationDisabled,
    work.readOnly,
    saveQuestionEdit,
    saveEdit,
    editSkillIds,
    editContext,
    editableSkills.data,
    searchEnabled,
    setSearchEnabled,
    reasoningEffort,
    setReasoningEffort,
    editResearchEnabled,
    setEditResearchEnabled,
    setEditSkillIds,
    stream.compactions,
    stream.files,
    stream.lookups,
    stream.live,
    stream.previews,
    stream.reading,
    stream.status,
    stream.steers,
    stream.tools,
  ]);

  // A card lives on the tool row that made it. Only what no row names yet is
  // placed by hand, in its own answer.
  const mine = (id: string | undefined, owner: string | undefined) =>
    id && owner === conversationId ? id : undefined;
  const shownAgentDrafts = shownIds(display, (activity) =>
    activity.family === "agent-draft"
      ? mine(activity.result?.draftId, activity.result?.draftConversationId)
      : undefined,
  );
  const shownScheduleDrafts = shownIds(display, (activity) =>
    activity.family === "schedule-draft"
      ? mine(activity.result?.draftId, activity.result?.draftConversationId)
      : undefined,
  );
  const shownDocuments = shownIds(display, (activity) =>
    activity.family === "document" &&
    createsDocument(activity.name) &&
    activity.result &&
    ownsDocument(activity.result, conversationId, data.project?.role ? data.project.id : null)
      ? activity.result.documentId
      : undefined,
  );
  const origin = new Map(
    [...data.agentDrafts, ...(data.scheduleDrafts ?? []), ...(data.documents ?? [])].map((item) => [
      item.id,
      item,
    ]),
  );
  const withPlacedCards = placeStranded(
    display,
    [
      ...draftIds
        .filter((draftId) => !shownAgentDrafts.has(draftId))
        .map((draftId) => ({
          key: `agent:${draftId}`,
          messageId: origin.get(draftId)?.messageId,
          activity: (message: DisplayMessage, index: number): ToolActivity => ({
            ...placed(message, index, draftId),
            family: "agent-draft",
            name: "draft_agent",
            result: { outcome: "drafted", draftId, draftConversationId: conversationId },
          }),
        })),
      ...scheduleDraftIds
        .filter((draftId) => !shownScheduleDrafts.has(draftId))
        .map((draftId) => ({
          key: `schedule:${draftId}`,
          messageId: origin.get(draftId)?.messageId,
          activity: (message: DisplayMessage, index: number): ToolActivity => ({
            ...placed(message, index, draftId),
            family: "schedule-draft",
            name: "draft_schedule",
            result: { outcome: "drafted", draftId, draftConversationId: conversationId },
          }),
        })),
      ...documentIds
        .filter((documentId) => !shownDocuments.has(documentId))
        .map((documentId) => {
          const title = (origin.get(documentId) as { title?: string } | undefined)?.title;
          return {
            key: `document:${documentId}:${title ?? ""}`,
            messageId: origin.get(documentId)?.messageId,
            activity: (message: DisplayMessage, index: number): ToolActivity => ({
              ...placed(message, index, documentId),
              family: "document",
              name: "create_document",
              result: {
                outcome: "created",
                documentId,
                documentConversationId: conversationId,
                ...(title ? { title } : {}),
              },
            }),
          };
        }),
    ],
    data.hasOlder,
  );

  const fileReferences = useMemo(() => {
    const attachments = new Map<string, Attachment>(
      (data.referenceAttachments ?? data.attachments).map((file) => [file.id, file]),
    );
    // The stored rows and the live answer's own, rather than the display, which
    // changes on every live chunk while these rarely do.
    const files = [...baseDisplay.flatMap((message) => message.files ?? []), ...stream.files];
    const steers = [...baseDisplay.flatMap((message) => message.steers ?? []), ...stream.steers];
    for (const file of files) attachments.set(file.attachment.id, file.attachment);
    for (const steer of steers)
      for (const file of steer.attachments) attachments.set(file.id, file);
    return {
      attachments,
      aliases: data.conversation.fileReferenceAliases ?? null,
      machineId: localMachineId,
    };
  }, [
    data.referenceAttachments,
    data.attachments,
    data.conversation.fileReferenceAliases,
    baseDisplay,
    stream.files,
    stream.steers,
    localMachineId,
  ]);

  return (
    <DocumentOwner
      documentIds={documentIds}
      goneIds={scopedForgottenDocuments}
      onGone={forgetDocument}
      autoOpenIds={liveCreated.document}
      onAsk={askFromDocument}
      onFocusComposer={focusComposer}
      ref={documents}
    >
      <AgentDraftOwner
        draftIds={draftIds}
        onGone={forgetDraft}
        autoOpenIds={liveCreated.agent}
        ref={agentDraft}
      >
        <ScheduleDraftOwner
          draftIds={scheduleDraftIds}
          onGone={forgetDraft}
          autoOpenIds={liveCreated.schedule}
          ref={scheduleDraft}
        >
          <div className="flex h-full flex-col">
            <ConversationCrumbs
              conversationId={conversationId}
              title={data.conversation.title}
              schedule={data.schedule}
              branchedFrom={data.branchedFrom}
              agent={data.agent}
              temporary={data.conversation.temporary}
              archived={!!data.conversation.archivedAt}
              project={data.project}
            />
            {foreignMachine ? (
              <ForeignMachineBanner conversationId={conversationId} stamp={foreignMachine} />
            ) : null}
            <div className="min-h-0 flex-1">
              <ResearchPanelOwner messages={display} />
              <SourcesPanelOwner messages={display} />
              {/* A Work row names a path; only this view knows whose folders it
              resolves against. */}
              <LocalFileConversationProvider
                conversationId={conversationId}
                workspaceRoot={folder?.status?.workspace.path ?? null}
              >
                <WritableChatProjectProvider
                  project={
                    data.project && projectCan.edit(data.project.role)
                      ? { id: data.project.id, name: data.project.name }
                      : null
                  }
                >
                  <FileReferenceContext value={fileReferences}>
                    <GenuiActionsContext value={genuiActions}>
                      <FileCommentContext value={sendFileComment}>
                        <VirtualMessageList
                          messages={withPlacedCards}
                          anchorId={anchorId}
                          onReleaseAnchor={releaseAnchor}
                          onReachStart={loadOlder}
                          loadingOlder={loadingOlder}
                        />
                      </FileCommentContext>
                    </GenuiActionsContext>
                  </FileReferenceContext>
                </WritableChatProjectProvider>
              </LocalFileConversationProvider>
            </div>
            {/* Mirrors the message column (scrollbar gutter + max-w + px) so the
          composer edges align exactly with message content above. No top
          padding: the scroller's fade mask handles the visual transition. */}
            <div className="pb-4 [scrollbar-gutter:stable_both-edges]">
              <div className="mx-auto w-full max-w-3xl px-4">
                {questionNeedsRefresh ? (
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-xs" role="alert">
                    <span>Your answers may not have been sent.</span>
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
                  conversationId={conversationId}
                  integrations={integrations}
                  folder={folder}
                  readOnly={work.readOnly}
                  mode={{ kind: "fixed", value: data.conversation.mode }}
                  settings={{
                    permissionLevel: data.conversation.permissionLevel,
                    onChange: (level) => workSettingsMutation.mutate(level),
                  }}
                  onSend={(
                    content,
                    attachmentIds,
                    researchEnabled,
                    skillIds,
                    workspaceFiles,
                    workspaceImports,
                  ) =>
                    sendMutation.mutateAsync({
                      content,
                      attachmentIds,
                      researchEnabled,
                      ...(skillIds ? { skillIds } : {}),
                      ...(workspaceFiles ? { workspaceFiles } : {}),
                      ...(workspaceImports ? { workspaceImports } : {}),
                    })
                  }
                  {...(generating ? { onQueue: conversationQueue.submit } : {})}
                  queue={conversationQueue.queue}
                  {...(stoppableId
                    ? {
                        onStop: () =>
                          stopMutation.mutate({
                            messageId: stoppableId,
                            ...(streamingMessage?.generationId
                              ? { generationId: streamingMessage.generationId }
                              : {}),
                          }),
                      }
                    : {})}
                  // A live answer locks destructive transcript actions, not the
                  // next draft. The composer submits that draft to the queue.
                  disabled={
                    questionNeedsRefresh ||
                    retryMutation.isPending ||
                    resumeMutation.isPending ||
                    editMutation.isPending ||
                    branchMutation.isPending
                  }
                  textareaDisabled={editPending}
                  controlsDisabled={mutationPending}
                  modelId={effectiveModelId}
                  onModelChange={changeModel}
                  searchEnabled={searchEnabled}
                  onSearchEnabledChange={setSearchEnabled}
                  reasoningEffort={reasoningEffort}
                  onReasoningEffortChange={setReasoningEffort}
                  imageModel={{
                    value: imageModelId,
                    lock: data.conversation.imageModelId,
                    agentPreference: data.agent?.imageModelId,
                    onChange: setImageModelId,
                  }}
                  context={context}
                />
              </div>
            </div>
          </div>
        </ScheduleDraftOwner>
      </AgentDraftOwner>
    </DocumentOwner>
  );
}

/** The edit in progress, drawn on the row it edits. */
interface RowEdit {
  readonly messageId: string;
  /** For a structured answer being edited, on the question row it answered. */
  readonly question: NonNullable<
    NonNullable<NonNullable<DisplayMessage["questionActions"]>["resolved"]>["editState"]
  >;
  readonly message: NonNullable<DisplayMessage["editState"]>;
}
/** What the answer being written shows from its stream until its rows arrive. */
interface LiveRow {
  readonly messageId: string;
  readonly files: NonNullable<DisplayMessage["files"]>;
  readonly tools: NonNullable<DisplayMessage["toolActivities"]>;
  readonly compactions: NonNullable<DisplayMessage["compactionActivities"]>;
  readonly steers: NonNullable<DisplayMessage["steers"]>;
  readonly text: NonNullable<DisplayMessage["liveStream"]>["text"];
  readonly status: NonNullable<DisplayMessage["liveStream"]>["status"];
  readonly reading: Exclude<DisplayMessage["reading"], undefined>;
  readonly lookups: Parameters<typeof mergeLookups>[1];
  readonly previews: NonNullable<DisplayMessage["imagePreviews"]>;
}

/**
 * A row as shown: the edit in progress over the row it edits, and the live stream over the
 * answer being written. Any other row is the very row given, so it does not draw again.
 */
function projectRow(
  base: DisplayMessage,
  edit: RowEdit | null,
  live: LiveRow | null,
): DisplayMessage {
  let projected = base;
  const resolved = base.questionActions?.resolved;
  if (resolved && edit?.messageId === resolved.messageId)
    projected = {
      ...projected,
      questionActions: {
        ...base.questionActions,
        resolved: { ...resolved, editState: edit.question },
      },
    };
  if (edit?.messageId === base.id) projected = { ...projected, editState: edit.message };
  if (base.id !== live?.messageId) return projected;
  // Overlay live stream state onto only the active assistant row. Its text is read by the row
  // itself (`liveStream`), so pacing ticks never rebuild this list.
  return {
    ...projected,
    files: live.files,
    toolActivities: live.tools.length > 0 ? live.tools : base.toolActivities,
    compactionActivities: live.compactions,
    // The stream has them the moment they are taken in; the rows arrive with the next
    // refetch. Same ids, so each is drawn once.
    steers: [
      ...(projected.steers ?? []),
      ...live.steers.filter((steer) => !projected.steers?.some((known) => known.id === steer.id)),
    ],
    liveStream: { text: live.text, status: live.status },
    reading: live.reading,
    uiLookups: mergeLookups(projected.uiLookups ?? NO_LOOKUPS, live.lookups),
    imagePreviews: live.previews,
  };
}
