import { useChatIntegrations } from "~/modules/integrations/client/use-chat-integrations.ts";

import { AgentDraftOwner, type AgentDraftHandle } from "~/modules/agents/ui/agent-draft-owner.tsx";
import {
  ScheduleDraftOwner,
  type ScheduleDraftHandle,
} from "~/modules/schedules/ui/schedule-draft-owner.tsx";
import { DocumentOwner, type DocumentOwnerHandle } from "~/modules/documents/ui/document-owner.tsx";
import { useDetailPanelSelectedId } from "~/ui/detail-panel-context.ts";
import { ConversationCrumbs } from "./conversation-crumbs.tsx";
import { DocumentToolName, projectDocumentResult } from "~/modules/documents/tool-schema.ts";

import { AgentDraftToolName, projectAgentDraftResult } from "~/modules/agents/tool-schema.ts";
import {
  ScheduleDraftToolName,
  projectScheduleDraftResult,
} from "~/modules/schedules/tool-schema.ts";

import { applyFileChunk, learnServerClock } from "../client/use-message-stream.ts";
import { lookupsOf, mergeLookups, NO_LOOKUPS, type AssistantFile } from "../assistant-output.ts";
import { collectSources } from "./citations.ts";
import { inheritSources } from "./inherited-sources.ts";

import { Schema } from "effect";
import { Folder01Icon, IncognitoIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { projectQuery } from "~/modules/projects/client/queries.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { conversationHistoryQuery, conversationQuery } from "../client/queries.ts";
import { withHistory } from "./conversation-window.ts";
import { browserTimeZone } from "../client/time-zone.ts";
import {
  applyCompactionChunk,
  applySteerChunk,
  applyToolActivityChunk,
  isStaleWriting,
  useMessageStream,
  type CompactionActivity,
  type ToolActivity,
} from "../client/use-message-stream.ts";
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
import type { ConversationMode, PermissionLevel } from "../schema.ts";
import { HeaderContent } from "~/ui/header-slot.tsx";
import { Toggle } from "~/ui/primitives/toggle";
import { AnimatePresence } from "motion/react";
import * as motion from "motion/react-m";
import { MotionSwap } from "~/ui/motion.tsx";
import { motionEase } from "~/ui/motion-presets.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
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
import type { AssistantSteer } from "./assistant-body.ts";
import { useWorkGate } from "~/modules/desktop/client/use-work-gate.ts";
import { LocalFileConversationProvider } from "~/modules/desktop/ui/local-file-preview.tsx";
import { FileReferenceContext } from "./file-reference-context.ts";
import type { Attachment } from "~/modules/attachments/schema.ts";
import { useWorkApprovals } from "~/modules/desktop/client/work-context.ts";
import { type ApprovalChoice } from "~/modules/desktop/client/approvals.ts";

import { agentIcon } from "./agent-icons.ts";
import { greetingFor } from "./greeting.ts";
import { associateQuestionResponses } from "./question-responses.ts";
import { buildMessageStamps } from "./timestamps.ts";
import { useSearchMode } from "./use-search-mode.ts";
import { useReasoningEffort } from "./use-reasoning-effort.ts";
import type { ReasoningEffort } from "~/modules/providers/model-config.ts";
import { skillsQuery } from "~/modules/skills/client/queries.ts";
import { useContextSelection } from "./use-context-selection.ts";
import type { DisplayMessage } from "./message-list.tsx";
import { PLACED_CALL_PREFIX } from "./live-message.ts";
import { VirtualMessageList } from "./virtual-message-list.tsx";
import { projectCan } from "~/modules/projects/schema.ts";
import { WritableChatProjectProvider } from "~/modules/projects/ui/save-to-project.tsx";
import { ResearchPanelOwner } from "./research-panel-owner.tsx";
import { SourcesPanelOwner } from "./sources-panel-owner.tsx";
import { useMarkRead } from "./use-mark-read.ts";
import { useBrowserChat } from "~/modules/browser/client/use-browser-chat.ts";
import { useAttachmentUploads } from "~/modules/attachments/client/use-attachment-uploads.ts";
import type { WorkspaceImports } from "~/modules/desktop/client/use-workspace-imports.ts";
import { uuidv7 } from "uuidv7";
import type { MessageAttachment } from "~/modules/attachments/schema.ts";
import { type QuestionResponse } from "~/modules/tools/ask-user-schema.ts";

import { PendingButton } from "~/ui/pending-button.tsx";
import { Button } from "~/ui/primitives/button";
import { useConfirm } from "~/ui/confirm-context.ts";
import { useAppReducedMotion, prefersReducedMotion } from "~/ui/reduced-motion.ts";
import { useIsMobile } from "~/ui/use-mobile.ts";
import { useDocumentTitle } from "~/ui/use-document-title.ts";
import { cn } from "~/ui/utils";
import { toastError } from "~/ui/error-toast.ts";
import {
  GenuiActionsContext,
  type SavedUiState,
  type UiMapLookup,
  type UiStateSave,
} from "~/modules/genui/ui/context.ts";
import { flushBlockSaves } from "~/modules/genui/ui/pending-saves.ts";
import { epoch, timedActivity, toCompactionActivity } from "./stored-activities.ts";
import { sendReservedWorkspaceTurn } from "./workspace-turn.ts";

/**
 * " The document “Plan” will also be deleted." for one casualty; counts per
 * kind for several. Empty when a rewind takes nothing of the sort.
 */
function lossSentence(items: ReadonlyArray<{ noun: string; name: string }>) {
  if (items.length === 0) return "";
  if (items.length === 1) {
    const [item] = items;
    return item!.name
      ? ` The ${item!.noun} “${item!.name}” will also be deleted.`
      : ` An untitled ${item!.noun} will also be deleted.`;
  }
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.noun, (counts.get(item.noun) ?? 0) + 1);
  const parts = [...counts].map(([noun, count]) => `${count} ${noun}${count === 1 ? "" : "s"}`);
  const list =
    parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return ` ${list} will also be deleted.`;
}

/** Something the transcript should show a card for, but no tool row names yet. */
interface Stranded {
  /** The answer that created it, when known. */
  messageId: string | null | undefined;
  activity: (message: DisplayMessage, index: number) => ToolActivity;
}

/**
 * Puts a card with no tool row of its own at the end of the answer that made
 * it: a document whose `create_document` row predates the column, or a draft
 * the loader reports before the tool rows arrive. Never under the transcript,
 * where it would read as belonging to the whole chat.
 */
function placeStranded(
  messages: DisplayMessage[],
  stranded: ReadonlyArray<Stranded>,
  /** Older turns are not loaded, so an unknown answer may simply be further up. */
  partial: boolean,
) {
  if (stranded.length === 0) return messages;
  const answers = messages.filter((message) => message.role === "assistant");
  const fallback = answers.at(-1)?.id;
  const byMessage = new Map<string, Stranded[]>();
  for (const item of stranded) {
    const anchor = item.messageId;
    const loaded = !!anchor && answers.some((message) => message.id === anchor);
    // Its answer is somewhere above: it appears there once that page loads.
    if (anchor && !loaded && partial) continue;
    const host = loaded ? anchor : fallback;
    if (!host) continue;
    const list = byMessage.get(host);
    if (list) list.push(item);
    else byMessage.set(host, [item]);
  }
  if (byMessage.size === 0) return messages;
  return messages.map((message) => {
    const items = byMessage.get(message.id);
    if (!items) return message;
    return {
      ...message,
      toolActivities: [
        ...message.toolActivities,
        ...items.map((item, index) => item.activity(message, index)),
      ],
    };
  });
}

/** The person's own message an answer replies to: the nearest one before it that is not a steer. */
const questionBefore = (
  messages: ReadonlyArray<{ id: string; role: string; steeredIntoMessageId?: string | null }>,
  answerId: string,
) => {
  const answer = messages.findIndex((message) => message.id === answerId);
  for (let index = answer - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user" && !message.steeredIntoMessageId) return message.id;
  }
  return null;
};

/** The ids a family's rows already show, so only the rest need placing. */
const shownIds = (
  messages: DisplayMessage[],
  pick: (activity: ToolActivity) => string | undefined,
) => new Set(messages.flatMap((message) => message.toolActivities.flatMap((a) => pick(a) ?? [])));

const placed = (message: DisplayMessage, index: number, id: string) => ({
  status: "complete" as const,
  callId: `${PLACED_CALL_PREFIX}${id}`,
  turnIndex: Number.MAX_SAFE_INTEGER,
  callIndex: index,
  textOffset: message.content.length,
});

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
  useEffect(() => {
    if (!isMobile) composer.current?.focus();
  }, [conversationId, isMobile]);
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
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editResearchEnabled, setEditResearchEnabled] = useState(false);
  // One instance, mounted for the whole view: an edit opens by seeding it, so
  // the chips survive the ChatInput remount that swapping the bubble causes.
  const editUploads = useAttachmentUploads();
  const seedEditUploads = editUploads.seed;
  const resetEditUploads = editUploads.reset;
  const submitEditUploads = editUploads.submit;
  const editUploadCount = editUploads.items.length;
  // Seeded from the edited message, like the uploads above: an edit changes the
  // message's own skills and collections, never the composer's live selection.
  const [editSkillIds, setEditSkillIds] = useState<ReadonlyArray<string>>([]);
  const activeEditingMessage =
    editingMessageId === null
      ? null
      : (data.messages.find((message) => message.id === editingMessageId) ?? null);
  // Bumped on retry/edit: the assistant id usually stays the same, so the
  // stream hook needs a separate signal to resubscribe from seq 0.
  const [retryEpoch, setRetryEpoch] = useState(0);
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

  const streamingMessage = data.messages.find((m) => m.status === "streaming");
  // A turn this tab started is read from its question: once its answer starts
  // streaming, that question is held at the top of the view. Decided while
  // rendering, so the new rows never commit with the list still following.
  // (Guarded render-time adjust.)
  const [anchorRequested, setAnchorRequested] = useState(
    // A first answer that already finished has nothing left to arrive.
    () => anchorFirstTurn && streamingMessage !== undefined,
  );
  const [anchorId, setAnchorId] = useState<string | null>(null);
  if (anchorRequested && streamingMessage) {
    setAnchorRequested(false);
    setAnchorId(questionBefore(data.messages, streamingMessage.id));
  }
  const releaseAnchor = useCallback(() => setAnchorId(null), []);
  // The row the stream overlay applies to. Sticky beyond streamingMessage:
  // when the generation finishes, the sync bus refetches and the row flips to
  // complete before the smoothed text drains. Dropping the overlay at that
  // moment would pop the tail in, exactly what smoothing exists to prevent.
  // (Guarded render-time adjust.)
  const [overlayId, setOverlayId] = useState<string | null>(null);
  if (streamingMessage && streamingMessage.id !== overlayId) {
    setOverlayId(streamingMessage.id);
  }
  // oxlint-disable react/memo-dependencies, react-hooks/exhaustive-deps -- pendingChunks are a snapshot for this streaming generation
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
      .map(timedActivity);
    // Starts can land between snapshots. Replay explicit anchors for every
    // family; terminal durable activities ignore older progress in the reducer.
    // A deck edit still being written replays too, until its call starts.
    const tools = data.pendingChunks.reduce<ToolActivity[]>(
      (current, chunk) =>
        chunk.kind === "tool" ||
        (chunk.kind === "writing" &&
          !isStaleWriting(chunk.delta, streamingMessage.generationId ?? null))
          ? applyToolActivityChunk(current, chunk.kind, chunk.delta, epoch(chunk.createdAt))
          : current,
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
      steers: data.pendingChunks
        .filter((chunk) => chunk.kind === "steer")
        .reduce<AssistantSteer[]>((steers, chunk) => applySteerChunk(steers, chunk.delta), []),
      files: data.pendingChunks
        .filter((chunk) => chunk.kind === "file")
        .reduce<AssistantFile[]>(
          (files, chunk) => applyFileChunk(files, chunk.delta),
          [...(streamingMessage.assistantOutput?.files ?? [])],
        ),
      text,
      reasoning,
      reasoningSeen: reasoningChunks.length > 0,
      tools,
      compactions,
      lookups: lookupsOf(streamingMessage.assistantOutput),
      lastSeq,
    };
  }, [streamingMessage?.id, streamingMessage?.generationId, retryEpoch]);
  // oxlint-enable react/memo-dependencies, react-hooks/exhaustive-deps

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
    subscribedMessage?.generationId ?? null,
    subscribedMessage?.status,
  );

  // A draft of this conversation, from any of the three paths that can reveal
  // one. References whose owning conversation is not this one are branch copies.
  const discoveredDrafts = useMemo(() => {
    const ids = new Set(data.agentDrafts.map((draft) => draft.id));
    const mine = (result: { draftId?: string; draftConversationId?: string }) => {
      if (result.draftId && result.draftConversationId === conversationId) ids.add(result.draftId);
    };
    for (const row of data.toolCalls)
      if (Schema.is(AgentDraftToolName)(row.toolName)) mine(projectAgentDraftResult(row.result));
    for (const activity of stream.tools)
      if (activity.family === "agent-draft" && activity.result) mine(activity.result);
    return ids;
  }, [conversationId, data.agentDrafts, data.toolCalls, stream.tools]);
  const discoveredScheduleDrafts = useMemo(() => {
    const ids = new Set((data.scheduleDrafts ?? []).map((draft) => draft.id));
    const mine = (result: { draftId?: string; draftConversationId?: string }) => {
      if (result.draftId && result.draftConversationId === conversationId) ids.add(result.draftId);
    };
    for (const row of data.toolCalls)
      if (Schema.is(ScheduleDraftToolName)(row.toolName))
        mine(projectScheduleDraftResult(row.result));
    for (const activity of stream.tools)
      if (activity.family === "schedule-draft" && activity.result) mine(activity.result);
    return ids;
  }, [conversationId, data.scheduleDrafts, data.toolCalls, stream.tools]);
  // The chat's own documents, and its project's while the person may still use it.
  const projectId = data.project?.role ? data.project.id : null;
  const discoveredDocuments = useMemo(() => {
    const ids = new Set((data.documents ?? []).map((document) => document.id));
    const mine = (result: DocumentOwnerFields) => {
      if (result.documentId && ownsDocument(result, conversationId, projectId))
        ids.add(result.documentId);
    };
    for (const row of data.toolCalls)
      if (Schema.is(DocumentToolName)(row.toolName)) mine(projectDocumentResult(row.result));
    for (const activity of stream.tools)
      if (activity.family === "document" && activity.result) mine(activity.result);
    return ids;
  }, [conversationId, data.documents, data.toolCalls, projectId, stream.tools]);
  // What the answer being watched just created, as opposed to what the page
  // loaded with: only these open their panel by themselves. A phone shows the
  // panel as a sheet over the answer, so it never opens one on its own there.
  const liveCreated = useMemo(() => {
    const loaded = new Set([
      ...data.agentDrafts.map((draft) => draft.id),
      ...(data.scheduleDrafts ?? []).map((draft) => draft.id),
      ...(data.documents ?? []).map((document) => document.id),
    ]);
    const fresh = {
      agent: new Set<string>(),
      schedule: new Set<string>(),
      document: new Set<string>(),
    };
    if (isMobile) return fresh;
    const add = (target: Set<string>, id: string | undefined, owner: string | undefined) => {
      if (id && owner === conversationId && !loaded.has(id)) target.add(id);
    };
    // A streamed creation makes the document before its call returns, so the
    // detail already lists it; one the answer streaming now made still opens.
    const writing = streamingMessage?.id;
    if (writing)
      for (const document of data.documents ?? [])
        if (document.messageId === writing) fresh.document.add(document.id);
    for (const activity of stream.tools) {
      if (activity.family === "agent-draft" && activity.result)
        add(fresh.agent, activity.result.draftId, activity.result.draftConversationId);
      else if (activity.family === "schedule-draft" && activity.result)
        add(fresh.schedule, activity.result.draftId, activity.result.draftConversationId);
      else if (
        activity.family === "document" &&
        activity.result &&
        ownsDocument(activity.result, conversationId, projectId)
      )
        add(fresh.document, activity.result.documentId, conversationId);
    }
    return fresh;
  }, [
    conversationId,
    data.agentDrafts,
    data.documents,
    data.scheduleDrafts,
    isMobile,
    projectId,
    stream.tools,
    streamingMessage?.id,
  ]);
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
  const openDocument = useRef<string | undefined>(undefined);
  openDocument.current = openDocumentId;
  const documentFocus = () => {
    const id = openDocument.current;
    if (!id) return {};
    const selected = documents.current?.selectedBlocks(id) ?? [];
    return { openDocument: selected.length ? { id, selected } : { id } };
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
      throw new Error("agent draft has unresolved changes");
    }
  };
  const flushScheduleDraft = async () => {
    if (hasScheduleDraft && !(await scheduleDraft.current?.flush())) {
      toast.error("Resolve the changes in your schedule draft before continuing.");
      throw new Error("schedule draft has unresolved changes");
    }
  };
  const flushDocuments = async () => {
    if (hasDocument && !(await documents.current?.flush())) {
      toast.error("Resolve the changes in your document before continuing.");
      throw new Error("document has unresolved changes");
    }
  };
  const checkWorkReady = () => work.check();
  const prepareGeneration = async () => {
    checkWorkReady();
    await flushBlockSaves();
    await flushAgentDraft();
    await flushScheduleDraft();
    await flushDocuments();
    closeEdit();
  };
  const beforeGeneration = async () => {
    await prepareGeneration();
    setAnchorRequested(true);
  };
  const cancelAnchor = () => setAnchorRequested(false);
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
    }) => {
      const conversation = { kind: "existing" as const, id: conversationId };
      const fields = {
        modelId: effectiveModelId!,
        content: input.content,
        searchEnabled,
        reasoningEffort,
        timeZone: browserTimeZone(),
        ...documentFocus(),
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
          ...(await work.attemptFields()),
          timeZone: browserTimeZone(),
          ...documentFocus(),
        },
      }),
    onSuccess: async (_result, input) => {
      if (input.modelId !== undefined) changeModel(input.modelId);
      // Refetch BEFORE bumping the epoch: the retried generation restarts at
      // seq 1, so the new subscription must be seeded from the wiped message
      // (after=0), not from the previous generation's chunk cursor.
      await queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
      setRetryEpoch((e) => e + 1);
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
      setRetryEpoch((e) => e + 1);
    },
  });

  // Branching leaves this conversation untouched and opens the copy, so the
  // only cache work here is making the new chat show up in the lists.
  const branchMutation = useMutation({
    onMutate: async () => {
      await flushBlockSaves();
      await flushAgentDraft();
      await flushDocuments();
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
  });

  const editMutation = useMutation({
    onMutate: async () => {
      checkWorkReady();
      await flushBlockSaves();
      await flushAgentDraft();
      await flushDocuments();
      setAnchorRequested(true);
    },
    mutationFn: async (
      input: {
        messageId: string;
        modelId: string;
        searchEnabled: boolean;
        reasoningEffort?: ReasoningEffort | null;
        researchEnabled?: boolean;
        attachmentIds: ReadonlyArray<string>;
        skillIds?: ReadonlyArray<string>;
        collectionIds?: ReadonlyArray<string>;
      } & (
        | { content: string; questionResponse?: never }
        | { questionResponse: QuestionResponse; content?: never }
      ),
    ) =>
      editMessage({
        data: {
          conversationId,
          researchEnabled: false,
          ...input,
          ...(await work.attemptFields()),
          timeZone: browserTimeZone(),
          ...documentFocus(),
        },
      }),
    onSuccess: async (_result, input) => {
      if (input.questionResponse) {
        await refreshQuestionState();
      } else {
        await queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
        // Only ordinary edits claim uploads and consume the composer's search mode.
        editUploads.markClaimed();
        setEditSkillIds([]);
        settleEditContext();
        resetSearchEnabled();
      }
      setEditingMessageId(null);
      setRetryEpoch((e) => e + 1);
    },
    onError: async (_error, input) => {
      cancelAnchor();
      if (!input.questionResponse) return;
      toast.error("Could not save your answers.");
      await refreshQuestionState();
    },
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
      searchEnabled,
      reasoningEffort,
      ...(await work.attemptFields()),
      timeZone: browserTimeZone(),
      ...documentFocus(),
      ...context.sendFields,
    }),
    attemptFields: () => work.attemptFields(),
    checkWork: checkWorkReady,
    settings: {
      modelId,
      setModelId,
      reasoningEffort,
      setReasoningEffort,
      searchPreference,
      setSearchEnabled,
      resetSearchEnabled,
      seedCollections: context.seed,
      settleCollections: context.settle,
    },
  });

  const machinesByMessage = useMemo(
    () =>
      new Map(
        (data.generations ?? []).map((row) => [row.messageId, row.desktopMachine?.id ?? null]),
      ),
    [data.generations],
  );
  const attachmentsByMessage = useMemo(() => {
    const grouped = new Map<string, MessageAttachment[]>();
    for (const attachment of data.attachments) {
      const list = grouped.get(attachment.messageId);
      if (list) list.push(attachment);
      else grouped.set(attachment.messageId, [attachment]);
    }
    return grouped;
  }, [data.attachments]);

  // A steer belongs to the answer it was delivered into and is drawn inside
  // it, so it never becomes a transcript row of its own.
  const steersByAnswer = useMemo(() => {
    const grouped = new Map<string, AssistantSteer[]>();
    for (const message of data.messages) {
      if (!message.steeredIntoMessageId) continue;
      const list = grouped.get(message.steeredIntoMessageId) ?? [];
      list.push({
        id: message.id,
        content: message.content,
        // Rows from before positions were recorded read as arriving first.
        textOffset: message.steerTextOffset ?? 0,
        turnIndex: message.steerTurnIndex ?? -1,
        attachments: attachmentsByMessage.get(message.id) ?? [],
      });
      grouped.set(message.steeredIntoMessageId, list);
    }
    return grouped;
  }, [attachmentsByMessage, data.messages]);

  // Grouped once per query result, since the display map below runs on every
  // stream chunk and must not rescan the flat list per message.
  const uiStatesByMessage = useMemo(() => {
    const grouped = new Map<string, Map<number, SavedUiState>>();
    for (const row of data.uiStates) {
      const states = grouped.get(row.messageId) ?? new Map<number, SavedUiState>();
      states.set(row.ordinal, {
        sourceHash: row.sourceHash,
        state: JSON.stringify(row.state),
        digest: row.digest ?? null,
      });
      grouped.set(row.messageId, states);
    }
    return grouped;
  }, [data.uiStates]);

  const toolCallsByMessage = useMemo(() => {
    const grouped = new Map<string, ToolActivity[]>();
    for (const row of data.toolCalls) {
      const activity = timedActivity(row);
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

  // Which model wrote each answer, null once its row is gone. The retry menu
  // marks it, and a retry that omits a model reuses it server-side.
  const modelByMessage = useMemo(
    () => new Map(data.messages.map((m) => [m.id, m.modelId])),
    [data.messages],
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
      editSkillIds,
      editContext,
    ],
  );

  // Durable rows change only with query data or global action availability. Live
  // stream and edit state are layered below so every unrelated row keeps its
  // object identity across stream chunks and local editor updates.

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
  // Workspace imports belong to the send that claimed them: the user message
  // before the attempt. Names only; the workspace path is this machine's.
  const workspaceFilesByUserMessage = useMemo(() => {
    const byAssistant = new Map(
      (data.generations ?? []).map((row) => [row.messageId, row.workspaceFiles ?? []] as const),
    );
    const result = new Map<string, ReadonlyArray<string>>();
    let previousUser: string | null = null;
    for (const message of data.messages) {
      if (message.role === "user") previousUser = message.id;
      else if (message.role === "assistant" && previousUser) {
        const files = byAssistant.get(message.id);
        if (files && files.length > 0) result.set(previousUser, files);
      }
    }
    return result;
  }, [data.generations, data.messages]);
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
                  disabled: generationDisabled || !effectiveModelId,
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
          };
        }

        if (base.id !== liveId) return projected;

        // Overlay live stream state onto only the active assistant row. Its
        // text is read by the row itself (`liveStream`), so pacing ticks never
        // rebuild this list.
        return {
          ...projected,
          files: stream.files,
          toolActivities: stream.tools.length > 0 ? stream.tools : base.toolActivities,
          compactionActivities: stream.compactions,
          // The stream has them the moment they are taken in; the rows arrive
          // with the next refetch. Same ids, so each is drawn once.
          steers: [
            ...(projected.steers ?? []),
            ...stream.steers.filter(
              (steer) => !projected.steers?.some((known) => known.id === steer.id),
            ),
          ],
          liveStream: { text: stream.live, status: stream.status },
          reading: stream.reading,
          uiLookups: mergeLookups(projected.uiLookups ?? NO_LOOKUPS, stream.lookups),
        };
      }),
    [
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
      stream.reading,
      stream.status,
      stream.steers,
      stream.tools,
    ],
  );

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
    activity.name === "create_document" &&
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
    for (const message of display) {
      for (const file of message.files ?? []) attachments.set(file.attachment.id, file.attachment);
      for (const steer of message.steers ?? [])
        for (const file of steer.attachments) attachments.set(file.id, file);
    }
    return {
      attachments,
      aliases: data.conversation.fileReferenceAliases ?? null,
      machineId: localMachineId,
    };
  }, [
    data.referenceAttachments,
    data.attachments,
    data.conversation.fileReferenceAliases,
    display,
    localMachineId,
  ]);

  return (
    <DocumentOwner
      documentIds={documentIds}
      goneIds={scopedForgottenDocuments}
      onGone={forgetDocument}
      autoOpenIds={liveCreated.document}
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
                      <VirtualMessageList
                        messages={withPlacedCards}
                        anchorId={anchorId}
                        onReleaseAnchor={releaseAnchor}
                        onReachStart={loadOlder}
                        loadingOlder={loadingOlder}
                      />
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

// How long the composer takes to travel from the middle of the column down to
// the bottom. Navigation waits this out, so a fast first response cannot swap
// the route in mid-slide, which would read as a jump rather than a move.
interface DocumentOwnerFields {
  documentId?: string;
  documentConversationId?: string;
  documentProjectId?: string;
}
/** A tool row's document is live here when this chat or its current project owns it. */
const ownsDocument = (
  result: DocumentOwnerFields,
  conversationId: string,
  projectId: string | null,
) =>
  result.documentConversationId === conversationId ||
  (projectId !== null && result.documentProjectId === projectId);

const SLIDE_MS = 380;

export function NewChatView({
  user,
  initialAgentId = null,
  initialSkillId = null,
  initialPrefill = null,
  onPrefillConsumed,
  temporary = false,
  onTemporaryChange,
  projectId = null,
}: {
  user: { name: string };
  /** Starts the chat as temporary; the route keeps it in the address. */
  temporary?: boolean;
  /** Starts the chat inside this project; never temporary. */
  projectId?: string | null;
  onTemporaryChange?: (temporary: boolean) => void;
  /** Pre-selected from an agent page; sent as an explicit install. */
  initialAgentId?: string | null;
  initialSkillId?: string | null;
  initialPrefill?: string | null;
  onPrefillConsumed?: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Fixed per visit so the line doesn't change while you type.
  const [greetingMoment] = useState(() => ({ now: new Date(), roll: Math.random() }));
  const [modelId, setModelId] = useState<string | null>(null);
  const { effort: reasoningEffort, setEffort: setReasoningEffort } = useReasoningEffort(modelId);
  const context = useContextSelection({
    mode: "draft",
    agent: initialAgentId ? { id: initialAgentId, name: null } : null,
  });
  const selectedAgentId = context.selection.agent?.id ?? null;
  const selectedAgent = context.detail;
  const {
    enabled: searchEnabled,
    setEnabled: setSearchEnabled,
    reset: resetSearchEnabled,
  } = useSearchMode(selectedAgent.data?.searchEnabled ?? true);
  const preferredModelApplied = useRef<string | null>(null);
  const modelOverride = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedAgentId) {
      preferredModelApplied.current = null;
      return;
    }
    if (!selectedAgent.data || preferredModelApplied.current === selectedAgentId) return;
    preferredModelApplied.current = selectedAgentId;
    if (modelOverride.current !== selectedAgentId && selectedAgent.data.model?.available) {
      setReasoningEffort(null);
      setModelId(selectedAgent.data.model.id);
    }
  }, [selectedAgentId, selectedAgent.data, setReasoningEffort]);
  const starters = selectedAgent.data?.starters ?? [];
  const composer = useRef<ComposerHandle>(null);
  const [mode, setMode] = useState<ConversationMode>("chat");
  // The final id exists before local folders or files do, so the first prompt
  // and every desktop capability already name the durable workspace path.
  const [conversationId] = useState(uuidv7);
  const work = useWorkGate(conversationId, mode === "work");
  // Held locally until the first message creates the chat and carries them.
  const integrations = useChatIntegrations(null);
  const folder = work.folder;
  const isMobile = useIsMobile();
  useEffect(() => {
    if (initialPrefill) composer.current?.prefillDraft(initialPrefill);
    onPrefillConsumed?.();
  }, [initialPrefill, onPrefillConsumed]);
  useEffect(() => {
    // matchMedia is read directly as well: `useIsMobile` reports "not mobile"
    // wherever it is missing, and a phone must not raise the keyboard.
    if (!isMobile && !window.matchMedia?.("(max-width: 767px)").matches) composer.current?.focus();
  }, [isMobile]);
  // Flipped the moment the first message actually leaves: the composer drops
  // into the position it occupies in ChatView, so the route swap that follows
  // lands on geometry that already matches.
  const [sending, setSending] = useState(false);
  // Resolves when the slide is over. A ref because the mutation callbacks that
  // await it are created once, not per render.
  const slide = useRef<Promise<void>>(Promise.resolve());

  const sendMutation = useMutation({
    mutationFn: async (input: {
      content: string;
      attachmentIds: ReadonlyArray<string>;
      researchEnabled: boolean;
      skillIds?: ReadonlyArray<string>;
      workspaceFiles?: ReadonlyArray<string>;
      workspaceImports?: WorkspaceImports;
      mode: ConversationMode;
    }) => {
      const conversation = {
        kind: "new" as const,
        id: conversationId,
        mode: input.mode,
        ...(input.mode === "chat" && temporary && !projectId ? { temporary: true } : {}),
        ...(projectId ? { projectId } : {}),
      };
      const fields = {
        modelId: modelId!,
        content: input.content,
        searchEnabled,
        reasoningEffort,
        timeZone: browserTimeZone(),
        attachmentIds: input.attachmentIds,
        researchEnabled: input.researchEnabled,
        skillIds: [...(input.skillIds ?? [])],
        ...context.sendFields,
        ...integrations.sendFields,
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
                ...(await work.attemptFields(true)),
                workspaceFiles: [...workspaceFiles],
              },
            }),
        });
      return sendMessage({
        data: {
          conversation,
          ...fields,
          ...(await work.attemptFields(input.mode === "work")),
        },
      });
    },
    // Fires when the request starts, i.e. after any queued upload settled.
    // the composer should not move while it is still waiting on those.
    onMutate: (input) => {
      work.check(input.mode === "work");
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
        state: { anchorNewTurn: true },
      });
    },
  });

  // A work chat keeps grants and folders on the machine, so it is never
  // temporary; nor is a project chat, which the project lists.
  const offerTemporary = mode === "chat" && !!onTemporaryChange && !projectId;
  const project = useQuery({ ...projectQuery(projectId ?? ""), enabled: !!projectId });
  const isTemporary = offerTemporary && temporary;
  const reducedMotion = useAppReducedMotion();

  return (
    <div className="flex h-full flex-col">
      {offerTemporary ? (
        <HeaderContent>
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  size="icon"
                  variant="solid"
                  className="ml-auto"
                  aria-label="Temporary chat"
                  pressed={temporary}
                  onPressedChange={onTemporaryChange}
                />
              }
            >
              {/* Keyed on the state, so each switch replays a small pop. */}
              <motion.span
                key={String(temporary)}
                className="flex"
                initial={reducedMotion ? false : { scale: 0.6, rotate: temporary ? -12 : 12 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ type: "spring", stiffness: 520, damping: 20 }}
              >
                <HugeiconsIcon icon={IncognitoIcon} strokeWidth={2} aria-hidden />
              </motion.span>
            </TooltipTrigger>
            <TooltipContent>
              {temporary ? "Turn off temporary chat" : "Start a temporary chat"}
            </TooltipContent>
          </Tooltip>
        </HeaderContent>
      ) : null}
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
            <h1 className="text-foreground text-2xl font-medium tracking-tight">
              <MotionSwap value={isTemporary ? "temporary" : "greeting"}>
                {isTemporary
                  ? "Temporary chat"
                  : greetingFor(user.name, greetingMoment.now, greetingMoment.roll)}
              </MotionSwap>
            </h1>
          )}
          {projectId && project.data ? (
            <Link
              to="/projects/$projectId"
              params={{ projectId }}
              className="text-muted-foreground hover:text-foreground mt-2 flex items-center gap-1.5 text-sm"
            >
              <HugeiconsIcon icon={Folder01Icon} strokeWidth={2} className="size-4" aria-hidden />
              In {project.data.name}
            </Link>
          ) : null}
          <AnimatePresence initial={false}>
            {isTemporary ? (
              <motion.div
                key="temporary"
                className="overflow-hidden"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: reducedMotion ? 0 : 0.18, ease: motionEase }}
              >
                <p className="text-muted-foreground max-w-md pt-2 text-sm">
                  This chat won’t appear in your history or use your memories.
                </p>
              </motion.div>
            ) : null}
          </AnimatePresence>
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
                  className="max-w-72"
                  onClick={() => composer.current?.seedDraft(starter)}
                >
                  <span className="truncate">{starter}</span>
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {/* Mirrors ChatView's composer wrapper exactly: same scrollbar gutter,
          max width and bottom padding, so the slide ends on the next route's
          resting position instead of near it. */}
      <div className="pb-4 [scrollbar-gutter:stable_both-edges]">
        <div className="mx-auto w-full max-w-3xl px-4">
          <Composer
            initialSkillId={initialSkillId}
            conversationId={conversationId}
            integrations={integrations}
            folder={folder}
            readOnly={work.readOnly}
            mode={{ kind: "choose", value: mode, onChange: setMode }}
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
                mode,
              })
            }
            disabled={sendMutation.isPending}
            modelId={modelId}
            onModelChange={(id, source) => {
              if (source !== "default") modelOverride.current = selectedAgentId;
              if (id !== modelId) setReasoningEffort(null);
              setModelId(id);
            }}
            searchEnabled={searchEnabled}
            onSearchEnabledChange={setSearchEnabled}
            reasoningEffort={reasoningEffort}
            onReasoningEffortChange={setReasoningEffort}
            context={{
              ...context,
              onAgentChange: (id) => {
                preferredModelApplied.current = null;
                modelOverride.current = null;
                // Picking another agent starts from that agent's default again.
                resetSearchEnabled();
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
