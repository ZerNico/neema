import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentDraftOwner } from "~/modules/agents/ui/agent-draft-owner.tsx";
import { FileCommentContext } from "~/modules/attachments/ui/file-comment.ts";
import { useBrowserChat } from "~/modules/browser/client/use-browser-chat.ts";
import { useLocalMachineId } from "~/modules/desktop/client/bridge.ts";
import { useWorkGate } from "~/modules/desktop/client/use-work-gate.ts";
import { ForeignMachineBanner } from "~/modules/desktop/ui/foreign-machine-banner.tsx";
import { foreignMachineStamp } from "~/modules/desktop/ui/foreign-machine-stamp.ts";
import { LocalFileConversationProvider } from "~/modules/desktop/ui/local-file-preview.tsx";
import { DocumentOwner } from "~/modules/documents/ui/document-owner.tsx";
import type { AskTarget } from "~/modules/documents/ui/rich-editor/editor-hooks.ts";
import {
  GenuiActionsContext,
  type UiMapLookup,
  type UiStateSave,
} from "~/modules/genui/ui/context.ts";
import { useChatIntegrations } from "~/modules/integrations/client/use-chat-integrations.ts";
import { projectCan } from "~/modules/projects/schema.ts";
import { WritableChatProjectProvider } from "~/modules/projects/ui/save-to-project.tsx";
import { ScheduleDraftOwner } from "~/modules/schedules/ui/schedule-draft-owner.tsx";
import { toastError } from "~/ui/error-toast.ts";
import { PendingButton } from "~/ui/pending-button.tsx";
import { useDocumentTitle } from "~/ui/use-document-title.ts";
import { useIsMobile } from "~/ui/use-mobile.ts";
import { conversationHistoryQuery, conversationQuery } from "../client/queries.ts";
import { browserTimeZone } from "../client/time-zone.ts";
import { learnServerClock } from "../client/use-message-stream.ts";
import type { PermissionLevel } from "../schema.ts";
import { lookupUiMap, saveUiState, updateWorkSettings } from "../server/functions.ts";
import { Composer, type ComposerHandle } from "./composer.tsx";
import { ConversationCrumbs } from "./conversation-crumbs.tsx";
import { withHistory } from "./conversation-window.ts";
import { FileReferenceContext } from "./file-reference-context.ts";
import { associateQuestionResponses } from "./question-responses.ts";
import { ResearchPanelOwner } from "./research-panel-owner.tsx";
import { SourcesPanelOwner } from "./sources-panel-owner.tsx";
import { useAttemptMutations } from "./use-attempt-mutations.ts";
import { useChatArtifacts } from "./use-chat-artifacts.ts";
import { useChatDisplay } from "./use-chat-display.ts";
import { useContextSelection } from "./use-context-selection.ts";
import { useConversationQueue } from "./use-conversation-queue.ts";
import { useLiveAnswer } from "./use-live-answer.ts";
import { useMarkRead } from "./use-mark-read.ts";
import { useMessageEdit } from "./use-message-edit.ts";
import { useMessageRows } from "./use-message-rows.ts";
import { useReasoningEffort } from "./use-reasoning-effort.ts";
import { useSearchMode } from "./use-search-mode.ts";
import { VirtualMessageList } from "./virtual-message-list.tsx";

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
  const { streamingMessage, stream, anchorId, releaseAnchor } = liveAnswer;
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

  const workSettingsMutation = useMutation({
    mutationFn: (permissionLevel: PermissionLevel) =>
      updateWorkSettings({ data: { conversationId, permissionLevel } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] }),
    onError: (error) => toastError("Could not change the approval level.", error),
  });
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
  const rows = useMessageRows(data);
  const messageEdit = useMessageEdit({
    data,
    questionResponses,
    attachmentsByMessage: rows.attachmentsByMessage,
    skillsByUserMessage: rows.skillsByUserMessage,
    collectionsByUserMessage: rows.collectionsByUserMessage,
  });
  const attempts = useAttemptMutations({
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
    generationDisabled,
    editPending,
    tailMessageId,
  } = attempts;

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

  const { display, withPlacedCards, fileReferences } = useChatDisplay({
    conversationId,
    data,
    rows,
    questionResponses,
    liveAnswer,
    messageEdit,
    attempts,
    work,
    localMachineId,
    effectiveModelId,
    changeModel,
    searchEnabled,
    setSearchEnabled,
    reasoningEffort,
    setReasoningEffort,
    draftIds,
    scheduleDraftIds,
    documentIds,
  });

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
