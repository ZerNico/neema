import { useMemo } from "react";
import type { Attachment } from "~/modules/attachments/schema.ts";
import type { ApprovalChoice } from "~/modules/desktop/client/approvals.ts";
import { useWorkApprovals } from "~/modules/desktop/client/work-context.ts";
import { useComputerApprovals } from "~/modules/computer/client/use-computer.ts";
import type { DesktopApprovalRequest } from "./desktop-activity-block.tsx";
import { lookupsOf, mergeLookups, NO_LOOKUPS } from "../assistant-output.ts";
import type { ToolActivity } from "../client/use-message-stream.ts";
import { createsDocument } from "./assistant-body.ts";
import { collectSources } from "./citations.ts";
import type { ConversationData } from "./conversation-window.ts";
import { inheritSources } from "./inherited-sources.ts";
import type { DisplayMessage } from "./message-list.tsx";
import type { associateQuestionResponses } from "./question-responses.ts";
import { placeStranded, placed, shownIds } from "./stranded-cards.ts";
import { buildMessageStamps } from "./timestamps.ts";
import type { useAttemptMutations } from "./use-attempt-mutations.ts";
import { ownsDocument } from "./use-discovered-artifacts.ts";
import type { useLiveAnswer } from "./use-live-answer.ts";
import type { useMessageEdit } from "./use-message-edit.ts";
import type { useMessageRows } from "./use-message-rows.ts";
import type { useReasoningEffort } from "./use-reasoning-effort.ts";
import type { useSearchMode } from "./use-search-mode.ts";

/**
 * The transcript as the chat shows it: stored rows with their actions, the
 * edit in progress and the live answer drawn over them, cards no tool row
 * names yet, and the files the messages may reference.
 */
export function useChatDisplay({
  conversationId,
  data,
  rows,
  questionResponses,
  liveAnswer,
  messageEdit,
  attempts,
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
}: {
  conversationId: string;
  data: ConversationData;
  rows: ReturnType<typeof useMessageRows>;
  questionResponses: ReturnType<typeof associateQuestionResponses>;
  liveAnswer: ReturnType<typeof useLiveAnswer>;
  messageEdit: ReturnType<typeof useMessageEdit>;
  attempts: ReturnType<typeof useAttemptMutations>;
  localMachineId: string | null;
  effectiveModelId: string | null;
  changeModel: (id: string) => void;
  searchEnabled: boolean;
  setSearchEnabled: ReturnType<typeof useSearchMode>["setEnabled"];
  reasoningEffort: ReturnType<typeof useReasoningEffort>["effort"];
  setReasoningEffort: ReturnType<typeof useReasoningEffort>["setEffort"];
  draftIds: readonly string[];
  scheduleDraftIds: readonly string[];
  documentIds: readonly string[];
}) {
  const {
    agentUnavailableByMessage,
    attachmentsByMessage,
    steersByAnswer,
    uiStatesByMessage,
    toolCallsByMessage,
    compactionsByMessage,
    nextAssistantAfter,
    modelByMessage,
    collectionsByUserMessage,
    skillsByUserMessage,
  } = rows;
  const { stream, liveId } = liveAnswer;
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
  } = attempts;
  const desktopApprovals = useWorkApprovals(conversationId);
  const computerApprovals = useComputerApprovals(conversationId);
  // Handed to every message; the card is found by call id, so only the message
  // holding that call renders one.
  // Browser calls wait on this page; computer calls wait on the server, so any device answers.
  const desktopApprovalRequests = useMemo(
    () =>
      new Map<string, DesktopApprovalRequest>([
        ...[...desktopApprovals.pending].map(
          ([callId, kind]) =>
            [
              callId,
              {
                kind,
                args: desktopApprovals.args(callId),
                decide: (choice: ApprovalChoice) => desktopApprovals.decide(callId, choice),
              },
            ] as const,
        ),
        ...[...computerApprovals].map(
          ([callId, call]) =>
            [
              callId,
              {
                kind: call.approval,
                machine: call.machine,
                reason: call.reason,
                args: call.args,
                // "Always" for a destination means every chat of the person.
                decide: (choice: ApprovalChoice) =>
                  call.decide(choice === "allow-always" ? "allow-everywhere" : choice),
              },
            ] as const,
        ),
      ]),
    [desktopApprovals, computerApprovals],
  );
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
        ...(attachmentsByMessage.has(message.id)
          ? { attachments: attachmentsByMessage.get(message.id)! }
          : {}),
        ...(agentUnavailableByMessage.has(message.id)
          ? { agentUnavailable: agentUnavailableByMessage.get(message.id)! }
          : {}),
        ...(skillsByUserMessage.has(message.id)
          ? { skills: skillsByUserMessage.get(message.id)! }
          : {}),
        ...(collectionsByUserMessage.has(message.id)
          ? { collectionIds: collectionsByUserMessage.get(message.id)! }
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
    agentUnavailableByMessage,
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
            saveDisabled: editPending,
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

  return { display, withPlacedCards, fileReferences };
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
