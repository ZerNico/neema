import { useChatIntegrations } from "~/modules/integrations/client/use-chat-integrations.ts";

import { AgentDraftOwner, type AgentDraftHandle } from "~/modules/agents/ui/agent-draft-owner.tsx";
import {
  ScheduleDraftOwner,
  type ScheduleDraftHandle,
} from "~/modules/schedules/ui/schedule-draft-owner.tsx";
import { DocumentOwner, type DocumentOwnerHandle } from "~/modules/documents/ui/document-owner.tsx";
import type { AskTarget } from "~/modules/documents/ui/rich-editor/editor-hooks.ts";
import { useDetailPanelSelectedId } from "~/ui/detail-panel-context.ts";
import { ConversationCrumbs } from "./conversation-crumbs.tsx";

import { learnServerClock } from "../client/use-message-stream.ts";
import { lookupsOf, mergeLookups, NO_LOOKUPS } from "../assistant-output.ts";
import { collectSources } from "./citations.ts";
import { inheritSources } from "./inherited-sources.ts";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { conversationHistoryQuery, conversationQuery } from "../client/queries.ts";
import { withHistory } from "./conversation-window.ts";
import { lossSentence } from "./rewind-loss.ts";
import { placeStranded, placed, shownIds } from "./stranded-cards.ts";
import { useLiveAnswer } from "./use-live-answer.ts";
import { browserTimeZone } from "../client/time-zone.ts";
import { type ToolActivity } from "../client/use-message-stream.ts";
import {
  activateWorkTurn,
  answerQuestion,
  branchConversation,
  editMessage,
  resumeMessage,
  retryMessage,
  lookupUiMap,
  saveUiState,
  sendMessage,
  stopGeneration,
  updateWorkSettings,
} from "../server/functions.ts";
import type { PermissionLevel } from "../schema.ts";

import { Composer, type ComposerHandle } from "./composer.tsx";
import {
  copyWorkspaceToBranch,
  desktopClient,
  useLocalMachineId,
} from "~/modules/desktop/client/bridge.ts";
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
import { ownsDocument, useDiscoveredArtifacts } from "./use-discovered-artifacts.ts";
import { useSearchMode } from "./use-search-mode.ts";
import { useReasoningEffort } from "./use-reasoning-effort.ts";
import type { ReasoningEffort } from "~/modules/providers/model-config.ts";
import { skillsQuery } from "~/modules/skills/client/queries.ts";
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
import { useAttachmentUploads } from "~/modules/attachments/client/use-attachment-uploads.ts";
import type { WorkspaceImports } from "~/modules/desktop/client/use-workspace-imports.ts";

import { type QuestionResponse } from "~/modules/tools/ask-user-schema.ts";

import { PendingButton } from "~/ui/pending-button.tsx";

import { useConfirm } from "~/ui/confirm-context.ts";

import { useIsMobile } from "~/ui/use-mobile.ts";
import { useDocumentTitle } from "~/ui/use-document-title.ts";

import { AlreadyTold, toastError } from "~/ui/error-toast.ts";
import {
  GenuiActionsContext,
  type UiMapLookup,
  type UiStateSave,
} from "~/modules/genui/ui/context.ts";
import { flushBlockSaves } from "~/modules/genui/ui/pending-saves.ts";

import { sendReservedWorkspaceTurn } from "./workspace-turn.ts";

/** Shared, so a conversation with nothing forgotten keeps its memos stable. */
const NO_IDS: ReadonlySet<string> = new Set();

export function ChatView({
  conversationId,
  anchorFirstTurn = false,
}: {
  conversationId: string;
  /** Opened by the new-chat page right after sending, so the answer arriving is ours. */
  anchorFirstTurn?: boolean;
}) {
  const agentDraft = useRef<AgentDraftHandle>(null);
  const scheduleDraft = useRef<ScheduleDraftHandle>(null);
  const documents = useRef<DocumentOwnerHandle>(null);
  const selectedPanelId = useDetailPanelSelectedId();
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
  const navigate = useNavigate();
  const confirm = useConfirm();
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
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editResearchEnabled, setEditResearchEnabled] = useState(false);
  // One instance, mounted for the whole view: an edit opens by seeding it, so
  // the chips survive the ChatInput remount that swapping the bubble causes.
  const editUploads = useAttachmentUploads();
  const seedEditUploads = editUploads.seed;
  const resetEditUploads = editUploads.reset;
  const submitEditUploads = editUploads.submit;
  const beginEditSubmission = editUploads.beginSubmission;
  const editUploadCount = editUploads.items.length;
  // Seeded from the edited message, like the uploads above: an edit changes the
  // message's own skills and collections, never the composer's live selection.
  const [editSkillIds, setEditSkillIds] = useState<ReadonlyArray<string>>([]);
  const activeEditingMessage =
    editingMessageId === null
      ? null
      : (data.messages.find((message) => message.id === editingMessageId) ?? null);
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

  const { streamingMessage, stream, liveId, anchorId, releaseAnchor, requestAnchor, cancelAnchor } =
    useLiveAnswer({ data, conversationId, anchorFirstTurn });

  // The chat's own documents, and its project's while the person may still use it.
  const projectId = data.project?.role ? data.project.id : null;
  const { discoveredDrafts, discoveredScheduleDrafts, discoveredDocuments, liveCreated } =
    useDiscoveredArtifacts({
      data,
      conversationId,
      projectId,
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
  // A draft goes with the answer that opened it, like a document, so the loader
  // summary plus live results are the whole truth. A discarded one is held out
  // until the refreshed loader and tool rows stop naming it.
  const [forgottenDrafts, setForgottenDrafts] = useState<{
    conversationId: string;
    ids: ReadonlySet<string>;
  }>({ conversationId, ids: new Set() });
  const scopedForgottenDrafts =
    forgottenDrafts.conversationId === conversationId ? forgottenDrafts.ids : NO_IDS;
  const draftIds = useMemo(
    () => [...discoveredDrafts].filter((draftId) => !scopedForgottenDrafts.has(draftId)).toSorted(),
    [discoveredDrafts, scopedForgottenDrafts],
  );
  const scheduleDraftIds = useMemo(
    () =>
      [...discoveredScheduleDrafts]
        .filter((draftId) => !scopedForgottenDrafts.has(draftId))
        .toSorted(),
    [discoveredScheduleDrafts, scopedForgottenDrafts],
  );
  // Draft ids are UUIDs, so one set serves both kinds.
  const forgetDraft = useCallback(
    (draftId: string) =>
      setForgottenDrafts((current) => {
        const ids =
          current.conversationId === conversationId ? new Set(current.ids) : new Set<string>();
        ids.add(draftId);
        return { conversationId, ids };
      }),
    [conversationId],
  );
  const hasAgentDraft = draftIds.length > 0;
  const hasScheduleDraft = scheduleDraftIds.length > 0;
  // Unlike a draft, a document does not outlive the answer that created it: a
  // rewind deletes it, so the loader summary plus live results are the whole
  // truth and there is nothing to retain across a retry.
  const [forgottenDocuments, setForgottenDocuments] = useState<{
    conversationId: string;
    ids: ReadonlySet<string>;
  }>({ conversationId, ids: new Set() });
  const scopedForgottenDocuments =
    forgottenDocuments.conversationId === conversationId ? forgottenDocuments.ids : NO_IDS;
  const documentIds = useMemo(
    () =>
      [...discoveredDocuments]
        .filter((documentId) => !scopedForgottenDocuments.has(documentId))
        .toSorted(),
    [discoveredDocuments, scopedForgottenDocuments],
  );
  const forgetDocument = useCallback(
    (documentId: string) =>
      setForgottenDocuments((current) => {
        const ids =
          current.conversationId === conversationId ? new Set(current.ids) : new Set<string>();
        ids.add(documentId);
        return { conversationId, ids };
      }),
    [conversationId],
  );
  const hasDocument = documentIds.length > 0;
  const openDocumentId =
    selectedPanelId?.startsWith("document:") &&
    documentIds.includes(selectedPanelId.slice("document:".length))
      ? selectedPanelId.slice("document:".length)
      : undefined;
  // Read by sends after their awaits, when this render's value may be stale: the latest
  // committed one.
  const openDocument = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    openDocument.current = openDocumentId;
  }, [openDocumentId]);
  const documentFocus = (asked?: AskTarget & { documentId: string }) => {
    const id = asked?.documentId ?? openDocument.current;
    if (!id) return {};
    const selected = asked ? [...asked.blocks] : (documents.current?.selectedBlocks(id) ?? []);
    return {
      openDocument: {
        id,
        ...(selected.length ? { selected } : {}),
        ...(asked?.thread ? { thread: asked.thread } : {}),
      },
    };
  };

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
  const editContext = useContextSelection({ mode: "installed", agent: data.agent });
  // The composer loads the same list inside itself; the editor is a second
  // consumer, and one shared query key means one fetch.
  const editableSkills = useQuery(skillsQuery);
  const seedEditContext = editContext.seed;
  const settleEditContext = editContext.settle;

  // Declared above the mutations: sending, answering, retrying and branching all
  // abandon an open edit, and each has to drop its uploads and selections rather
  // than just forgetting which message was being edited.
  const closeEdit = useCallback(() => {
    // Runs on every send/answer/retry/branch, so it must cost nothing when no
    // edit is open: resetting then would throw away the composer's own uploads.
    if (!editingMessageId) return;
    setEditingMessageId(null);
    setEditSkillIds([]);
    setEditResearchEnabled(false);
    settleEditContext();
    // Structured edits have no upload lifecycle of their own.
    if (!questionResponses.hiddenMessageIds.has(editingMessageId)) resetEditUploads();
  }, [resetEditUploads, editingMessageId, questionResponses, settleEditContext]);

  // Blocking a generation has to say so: onMutate throwing cancels the mutation,
  // and send/retry/branch carry no onError of their own, so without this the
  // button would simply do nothing.
  const flushAgentDraft = async () => {
    if (hasAgentDraft && !(await agentDraft.current?.flush())) {
      toast.error("Resolve the changes in your agent draft before continuing.");
      throw new AlreadyTold("agent draft has unresolved changes");
    }
  };
  const flushScheduleDraft = async () => {
    if (hasScheduleDraft && !(await scheduleDraft.current?.flush())) {
      toast.error("Resolve the changes in your schedule draft before continuing.");
      throw new AlreadyTold("schedule draft has unresolved changes");
    }
  };
  const flushDocuments = async () => {
    if (hasDocument && !(await documents.current?.flush())) {
      toast.error("Resolve the changes in your document before continuing.");
      throw new AlreadyTold("document has unresolved changes");
    }
  };
  const checkWorkReady = () => work.check();
  /** What every way of starting an answer saves first, so it reads current drafts. */
  const flushPending = async () => {
    await flushBlockSaves();
    await flushAgentDraft();
    await flushScheduleDraft();
    await flushDocuments();
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
  // Below the per-message maps it seeds from. Opening an editor while another is
  // open is an ordinary switch: the previous draft goes with its unmounted row.
  const openEdit = useCallback(
    (messageId: string) => {
      setEditingMessageId(messageId);
      // The offer belongs to the edit being written, not to the one before it.
      setEditResearchEnabled(false);
      if (questionResponses.hiddenMessageIds.has(messageId)) {
        // An answer edit has no uploads of its own, so there is nothing to seed.
        // Only a switch away from another editor leaves chips needing clearing.
        if (editingMessageId !== null && editingMessageId !== messageId) resetEditUploads();
      } else {
        // Seeded as existing/claimed: removing one only drops it from the
        // replacement set, it is released by the save itself.
        seedEditUploads(attachmentsByMessage.get(messageId) ?? []);
      }
      setEditSkillIds((skillsByUserMessage.get(messageId) ?? []).map((skill) => skill.id));
      // A message records the *effective* collections. The agent's own are in the
      // selection already; reseeding them as standalone would rewrite the turn's
      // provenance, so only the standalone remainder is seeded.
      const fromAgent = new Set(data.agent?.collectionIds ?? []);
      seedEditContext(
        (collectionsByUserMessage.get(messageId) ?? []).filter((id) => !fromAgent.has(id)),
      );
    },
    [
      attachmentsByMessage,
      seedEditUploads,
      resetEditUploads,
      questionResponses,
      editingMessageId,
      skillsByUserMessage,
      collectionsByUserMessage,
      seedEditContext,
      data.agent,
    ],
  );

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
