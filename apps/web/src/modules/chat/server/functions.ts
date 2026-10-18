import { notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { UNAUTHENTICATED_BODY } from "~/modules/auth/identity.ts";
import { NOT_APPROVED_BODY } from "~/modules/auth/signup.ts";
import type { AccountIneligible } from "~/modules/auth/server/account-eligibility.ts";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { runtime } from "~/server/runtime.ts";
import {
  AnswerQuestionInput,
  SaveUiStateInput,
  LookupUiMapInput,
  BranchConversationInput,
  ConversationArchiveInput,
  ConversationDetailInput,
  ConversationHistoryInput,
  ConversationIdInput,
  ConversationRestoreInput,
  EditMessageInput,
  ListConversationsInput,
  MessageIdInput,
  RenameConversationInput,
  ReserveWorkTurnInput,
  WorkTurnReservationInput,
  ActivateWorkTurnInput,
  UpdateWorkSettingsInput,
  RetryMessageInput,
  ResumeMessageInput,
  SearchChatsInput,
  SendMessageInput,
  QueueMessageInput,
  QueueEntryIdInput,
  ReplaceQueueEntryInput,
  DispatchQueueInput,
  SendQueuedNowInput,
  SteerQueueEntryInput,
} from "../schema.ts";
import { loadConversationDetail, loadConversationHistory } from "./conversation-detail.ts";
import { ChatRepo } from "./repo.ts";
import { MapLookups } from "~/modules/genui/server/map-lookups.ts";
import { resolvePageLookups } from "~/modules/genui/server/page-lookups.ts";
import { MAPS_TOOL, readMaps } from "~/modules/genui/settings.ts";
import { ToolsRepo } from "~/modules/tools/server/repo.ts";
import type { JsonValue } from "~/db/schema/providers.ts";
import { ChatService, type DesktopFolderRef } from "./service.ts";

const standard = Schema.toStandardSchemaV1;

const CONVERSATIONS_DEFAULT_LIMIT = 30;

export const listConversations = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(standard(ListConversationsInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      ChatRepo.use((repo) =>
        repo
          .listConversations({
            userId: context.session.user.id,
            limit: data.limit ?? CONVERSATIONS_DEFAULT_LIMIT,
            ...(data.query === undefined ? {} : { query: data.query }),
            ...(data.outsideProjects ? { outsideProjects: true } : {}),
            ...(data.cursor === undefined
              ? {}
              : { cursor: { activity: new Date(data.cursor.activity), id: data.cursor.id } }),
          })
          // The cursor goes back out exactly as it came in: a string the
          // client round-trips without having to know what is in it.
          .pipe(
            Effect.map((page) => ({
              conversations: page.conversations,
              nextCursor: page.nextCursor
                ? { activity: page.nextCursor.activity.toISOString(), id: page.nextCursor.id }
                : null,
            })),
          ),
      ),
    ),
  );

/** The palette's chat results: titles and message text, see ChatRepo.searchConversations. */
export const searchChats = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(standard(SearchChatsInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      ChatRepo.use((repo) =>
        repo.searchConversations({
          userId: context.session.user.id,
          query: data.query,
          limit: data.limit ?? 8,
        }),
      ),
    ),
  );

export const getConversationWithMessages = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(standard(ConversationDetailInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      loadConversationDetail(context.session.user.id, data.conversationId, data.anchorId).pipe(
        // Preserve missing-resource semantics across the server-function
        // boundary so route loaders can render their not-found state.
        Effect.catchTag("ConversationNotFound", () => Effect.die(notFound())),
      ),
    ),
  );

export const getConversationHistory = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(standard(ConversationHistoryInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      loadConversationHistory(context.session.user.id, data.conversationId, data.beforeId).pipe(
        Effect.catchTag("ConversationNotFound", () => Effect.die(notFound())),
      ),
    ),
  );

/** A new turn, sent from the composer or activated from a desktop reservation. */
const startTurn = (
  data: typeof SendMessageInput.Type & { reservationId?: string },
  session: { user: { id: string }; session: { id: string } },
) =>
  runtime.runPromise(
    Effect.flatMap(ChatService, (chat) =>
      chat.sendMessage({
        userId: session.user.id,
        ...(data.reservationId === undefined ? {} : { reservationId: data.reservationId }),
        conversation: data.conversation,
        modelId: data.modelId,
        imageModelId: data.imageModelId,
        reasoningEffort: data.reasoningEffort,
        content: data.content,
        researchEnabled: data.researchEnabled,
        searchEnabled: data.searchEnabled,
        desktopFolders: data.desktopFolders,
        desktopCommands: data.desktopCommands,
        desktopBrowser: data.desktopBrowser,
        fromDesktop: data.fromDesktop,
        desktopExecutorId: data.desktopExecutorId,
        desktopMachineId: data.desktopMachineId,
        desktopMachineName: data.desktopMachineName,
        workspaceFiles: data.workspaceFiles,
        deviceSessionId: session.session.id,
        timeZone: data.timeZone,
        openDocument: data.openDocument,
        attachmentIds: data.attachmentIds,
        agentId: data.agentId,
        collectionIds: data.collectionIds,
        skillIds: data.skillIds,
        integrationChoices: data.integrationChoices,
      }),
    ).pipe(
      Effect.catchTags({
        AccountIneligible: accountIneligible,
        IntegrationNotAvailable: selectedIntegrationGone,
        AgentNotAvailable: selectedAgentGone,
        WorkDesktopRequired: workChat,
        KnowledgeNotAvailable: selectedKnowledgeGone,
        SkillNotAvailable: selectedSkillGone,
        SkillRejected: rejected,
        KnowledgeRejected: rejected,
        ModelNotFound: unknownModel,
        ConversationNotFound: missing,
        ConversationBusy: busy,
        ToolUnavailable: searchUnavailable,
        InvalidMessage: rejected,
        AttachmentUnsupported: unreadable,
        AttachmentNotAvailable: attachmentGone,
      }),
    ),
  );

export const sendMessage = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(SendMessageInput))
  .handler(({ data, context }) => startTurn(data, context.session));

export const reserveWorkTurn = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(ReserveWorkTurnInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      ChatService.use((chat) =>
        chat.reserveWorkTurn({
          id: data.reservationId,
          userId: context.session.user.id,
          conversation: data.conversation,
        }),
      ).pipe(
        Effect.catchTags({
          ConversationNotFound: missing,
          ConversationBusy: busy,
          // Not the message's fault: the reservation no longer fits this chat.
          InvalidMessage: notAllowed,
        }),
      ),
    ),
  );

export const activateWorkTurn = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(ActivateWorkTurnInput))
  .handler(({ data, context }) => startTurn(data, context.session));

export const getWorkTurnReservation = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(WorkTurnReservationInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      ChatService.use((chat) =>
        chat.getWorkTurnReservation({
          userId: context.session.user.id,
          reservationId: data.reservationId,
        }),
      ).pipe(Effect.catchTag("ConversationNotFound", missing)),
    ),
  );

export const abortWorkTurn = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(WorkTurnReservationInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      ChatService.use((chat) =>
        chat.abortWorkTurn({
          userId: context.session.user.id,
          reservationId: data.reservationId,
        }),
      ).pipe(Effect.catchTag("ConversationNotFound", missing)),
    ),
  );

/** The fields a queued submission carries, shared by queueing and editing. */
const queueSubmission = (
  data: typeof QueueMessageInput.Type,
  session: { user: { id: string }; session: { id: string } },
) => ({
  userId: session.user.id,
  conversationId: data.conversationId,
  content: data.content,
  attachmentIds: data.attachmentIds,
  input: {
    modelId: data.modelId,
    ...(data.imageModelId ? { imageModelId: data.imageModelId } : {}),
    ...(data.reasoningEffort !== undefined ? { reasoningEffort: data.reasoningEffort } : {}),
    searchEnabled: data.searchEnabled,
    researchEnabled: data.researchEnabled,
    skillIds: data.skillIds,
    collectionIds: data.collectionIds,
    timeZone: data.timeZone,
    openDocument: data.openDocument,
  },
  desktop: desktopDispatch(data, session.session.id),
});

/** Only a request from the desktop app names a machine; anything else is none. */
const desktopDispatch = (
  data: {
    fromDesktop?: boolean;
    desktopFolders?: ReadonlyArray<DesktopFolderRef>;
    desktopCommands?: boolean;
    desktopBrowser?: boolean;
    desktopExecutorId?: string;
    desktopMachineId?: string;
    desktopMachineName?: string;
  },
  deviceSessionId: string,
) =>
  data.fromDesktop && data.desktopExecutorId
    ? {
        fromDesktop: true,
        desktopFolders: data.desktopFolders,
        desktopCommands: data.desktopCommands,
        desktopBrowser: data.desktopBrowser,
        desktopExecutorId: data.desktopExecutorId,
        desktopMachineId: data.desktopMachineId,
        desktopMachineName: data.desktopMachineName,
        deviceSessionId,
      }
    : undefined;

/**
 * How a message is refused, whichever way it came: a send, an answer to a
 * question, a retry, a resume, an edit or a queued entry. Each function lists
 * the failures its own call can raise; the wording lives here once, so the
 * same failure reads the same wherever it surfaces.
 */
const refuse = (status: number, message: string) => Effect.die(new Response(message, { status }));
const accountIneligible = (error: AccountIneligible) =>
  error.reason === "unapproved"
    ? refuse(403, NOT_APPROVED_BODY)
    : refuse(401, UNAUTHENTICATED_BODY);
const missing = () => refuse(404, "Not found");
const unknownModel = () => refuse(400, "Unknown model");
const busy = () => refuse(409, "A response is still generating");
const workChat = () => refuse(409, "This is a work chat; continue it from the desktop app");
const searchUnavailable = (error: { reason: string }) =>
  refuse(400, `Web search unavailable: ${error.reason}`);
const rejected = (error: { reason: string }) => refuse(400, error.reason);
const notAllowed = (error: { reason: string }) => refuse(409, error.reason);
const unreadable = (error: { fileName: string; reason: string }) =>
  refuse(400, `${error.fileName}: ${error.reason}`);
// Claimed by another message, or gone. The chip is stale either way.
const attachmentGone = () => refuse(409, "An attachment is no longer available");
// A new message picks its agent and collections now; a continuing one reuses
// what its answers used, which may have gone since.
const selectedAgentGone = () => refuse(404, "The selected agent is not available");
const selectedIntegrationGone = () => refuse(404, "A selected integration is not available");
const selectedKnowledgeGone = () => refuse(404, "A selected collection is not available");
const selectedSkillGone = () => refuse(404, "A selected skill is not available");
const chatAgentGone = () => refuse(409, "This chat’s agent is no longer available");
const usedKnowledgeGone = () => refuse(409, "Knowledge this answer used is no longer available");
const usedSkillGone = () => refuse(409, "A skill this answer used is no longer available");

export const queueMessage = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(QueueMessageInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      ChatService.use((chat) => chat.queueMessage(queueSubmission(data, context.session))).pipe(
        Effect.catchTags({
          ConversationNotFound: missing,
          ModelNotFound: unknownModel,
          WorkDesktopRequired: workChat,
          ToolUnavailable: searchUnavailable,
          InvalidMessage: rejected,
          AttachmentUnsupported: unreadable,
          AttachmentNotAvailable: attachmentGone,
          QueueFull: () => refuse(409, "Too many messages are queued"),
        }),
      ),
    ),
  );

export const replaceQueuedMessage = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(ReplaceQueueEntryInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      ChatService.use((chat) =>
        chat.replaceQueuedMessage({
          ...queueSubmission(data, context.session),
          entryId: data.entryId,
        }),
      ).pipe(
        Effect.catchTags({
          ConversationNotFound: missing,
          ModelNotFound: unknownModel,
          WorkDesktopRequired: workChat,
          ToolUnavailable: searchUnavailable,
          InvalidMessage: rejected,
          AttachmentUnsupported: unreadable,
          AttachmentNotAvailable: attachmentGone,
          QueueEntryNotFound: () =>
            refuse(409, "This queued message already started or was removed"),
        }),
      ),
    ),
  );

export const removeQueuedMessage = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(QueueEntryIdInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      ChatService.use((chat) =>
        chat.removeQueuedMessage({ userId: context.session.user.id, ...data }),
      ).pipe(Effect.catchTag("ConversationNotFound", missing)),
    ),
  );

export const steerQueuedMessage = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(SteerQueueEntryInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      ChatService.use((chat) =>
        chat.steerQueuedMessage({ userId: context.session.user.id, ...data }),
      ).pipe(
        Effect.catchTags({
          ConversationNotFound: missing,
          QueueEntryNotFound: () => refuse(409, "Queued message no longer exists"),
          NoActiveGeneration: () => refuse(409, "That response already finished"),
          AttachmentUnsupported: (error) =>
            refuse(400, `The running answer can’t read ${error.fileName}: ${error.reason}`),
        }),
      ),
    ),
  );

export const dispatchQueuedMessage = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(DispatchQueueInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      ChatService.use((chat) =>
        chat.dispatchQueuedMessage({
          userId: context.session.user.id,
          conversationId: data.conversationId,
          force: data.force,
          desktop: desktopDispatch(data, context.session.session.id),
        }),
      ).pipe(
        Effect.catchTags({
          AccountIneligible: accountIneligible,
          ConversationNotFound: missing,
        }),
        // Other resolution failures read the same to a person: the queued
        // message cannot start right now and is kept for them to decide on.
        Effect.catch(() =>
          Effect.die(new Response("This message could not be started", { status: 409 })),
        ),
      ),
    ),
  );

export const sendQueuedNow = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(SendQueuedNowInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      ChatService.use((chat) =>
        chat.sendQueuedNow({
          userId: context.session.user.id,
          conversationId: data.conversationId,
          entryId: data.entryId,
          desktop: desktopDispatch(data, context.session.session.id),
        }),
      ).pipe(
        Effect.catchTags({
          AccountIneligible: accountIneligible,
          ConversationNotFound: missing,
          MessageNotFound: missing,
        }),
        // The reason is already on the entry; the person sees it in the strip.
        Effect.catch(() =>
          Effect.die(new Response("This message could not be started", { status: 409 })),
        ),
      ),
    ),
  );

export const answerQuestion = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(AnswerQuestionInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      ChatService.use((chat) =>
        chat.sendMessage({
          userId: context.session.user.id,
          conversation: { kind: "existing", id: data.conversationId },
          modelId: data.modelId,
          searchEnabled: data.searchEnabled,
          researchEnabled: data.researchEnabled,
          desktopFolders: data.desktopFolders,
          desktopCommands: data.desktopCommands,
          desktopBrowser: data.desktopBrowser,
          fromDesktop: data.fromDesktop,
          desktopExecutorId: data.desktopExecutorId,
          desktopMachineId: data.desktopMachineId,
          desktopMachineName: data.desktopMachineName,
          deviceSessionId: context.session.session.id,
          timeZone: data.timeZone,
          openDocument: data.openDocument,
          attachmentIds: [],
          questionResponse: { callId: data.callId, response: data.response },
          reasoningEffort: data.reasoningEffort,
        }),
      ).pipe(
        Effect.catchTags({
          AccountIneligible: accountIneligible,
          AgentNotAvailable: chatAgentGone,
          WorkDesktopRequired: workChat,
          KnowledgeNotAvailable: usedKnowledgeGone,
          SkillNotAvailable: usedSkillGone,
          SkillRejected: rejected,
          KnowledgeRejected: rejected,
          ConversationNotFound: missing,
          ModelNotFound: unknownModel,
          ConversationBusy: busy,
          InvalidMessage: rejected,
          AttachmentUnsupported: unreadable,
          AttachmentNotAvailable: attachmentGone,
          ToolUnavailable: searchUnavailable,
          QuestionUnavailable: () =>
            refuse(409, "These questions are no longer available. Refresh the conversation."),
        }),
      ),
    ),
  );

export const retryMessage = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(RetryMessageInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      ChatService.use((chat) =>
        chat.retryMessage({
          fromDesktop: data.fromDesktop,
          desktopExecutorId: data.desktopExecutorId,
          desktopMachineId: data.desktopMachineId,
          desktopMachineName: data.desktopMachineName,
          deviceSessionId: context.session.session.id,
          desktopFolders: data.desktopFolders,
          desktopCommands: data.desktopCommands,
          desktopBrowser: data.desktopBrowser,
          userId: context.session.user.id,
          conversationId: data.conversationId,
          messageId: data.messageId,
          modelId: data.modelId,
          imageModelId: data.imageModelId,
          timeZone: data.timeZone,
          openDocument: data.openDocument,
        }),
      ).pipe(
        Effect.catchTags({
          AccountIneligible: accountIneligible,
          AgentNotAvailable: chatAgentGone,
          WorkDesktopRequired: workChat,
          KnowledgeNotAvailable: usedKnowledgeGone,
          SkillNotAvailable: usedSkillGone,
          SkillRejected: rejected,
          KnowledgeRejected: rejected,
          ConversationNotFound: missing,
          ModelNotFound: unknownModel,
          ConversationBusy: busy,
          InvalidMessage: rejected,
          AttachmentUnsupported: unreadable,
          AttachmentNotAvailable: attachmentGone,
          MessageNotFound: missing,
          RetryNotAllowed: notAllowed,
        }),
      ),
    ),
  );

export const resumeMessage = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(ResumeMessageInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      ChatService.use((chat) =>
        chat.resumeMessage({
          fromDesktop: data.fromDesktop,
          desktopExecutorId: data.desktopExecutorId,
          desktopMachineId: data.desktopMachineId,
          desktopMachineName: data.desktopMachineName,
          deviceSessionId: context.session.session.id,
          desktopFolders: data.desktopFolders,
          desktopCommands: data.desktopCommands,
          desktopBrowser: data.desktopBrowser,
          userId: context.session.user.id,
          conversationId: data.conversationId,
          messageId: data.messageId,
          modelId: data.modelId,
          timeZone: data.timeZone,
          openDocument: data.openDocument,
        }),
      ).pipe(
        Effect.catchTags({
          AccountIneligible: accountIneligible,
          AgentNotAvailable: chatAgentGone,
          WorkDesktopRequired: workChat,
          KnowledgeNotAvailable: usedKnowledgeGone,
          SkillNotAvailable: usedSkillGone,
          SkillRejected: rejected,
          KnowledgeRejected: rejected,
          ConversationNotFound: missing,
          ModelNotFound: unknownModel,
          ConversationBusy: busy,
          InvalidMessage: rejected,
          AttachmentUnsupported: unreadable,
          AttachmentNotAvailable: attachmentGone,
          MessageNotFound: missing,
          ResumeNotAllowed: notAllowed,
        }),
      ),
    ),
  );

export const branchConversation = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(BranchConversationInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      ChatService.use((chat) =>
        chat.branchConversation({
          userId: context.session.user.id,
          conversationId: data.conversationId,
          messageId: data.messageId,
        }),
      ).pipe(
        Effect.catchTags({
          ConversationNotFound: missing,
          MessageNotFound: missing,
          BranchNotAllowed: notAllowed,
          ConversationBusy: busy,
        }),
      ),
    ),
  );

export const stopGeneration = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(MessageIdInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      ChatService.use((chat) =>
        chat.stopGeneration({
          generationId: data.generationId,
          userId: context.session.user.id,
          conversationId: data.conversationId,
          messageId: data.messageId,
        }),
      ).pipe(Effect.catchTags({ ConversationNotFound: missing, MessageNotFound: missing })),
    ),
  );

export const editMessage = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(EditMessageInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      ChatService.use((chat) =>
        chat.editMessage({
          ...data,
          userId: context.session.user.id,
          deviceSessionId: context.session.session.id,
        }),
      ).pipe(
        Effect.catchTags({
          AccountIneligible: accountIneligible,
          AgentNotAvailable: chatAgentGone,
          WorkDesktopRequired: workChat,
          KnowledgeNotAvailable: usedKnowledgeGone,
          SkillNotAvailable: usedSkillGone,
          SkillRejected: rejected,
          KnowledgeRejected: rejected,
          ConversationNotFound: missing,
          ModelNotFound: unknownModel,
          ConversationBusy: busy,
          InvalidMessage: rejected,
          AttachmentUnsupported: unreadable,
          AttachmentNotAvailable: attachmentGone,
          MessageNotFound: missing,
          ToolUnavailable: searchUnavailable,
          EditNotAllowed: notAllowed,
        }),
      ),
    ),
  );

export const deleteConversation = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(ConversationIdInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      ChatService.use((chat) =>
        chat.deleteConversation({
          userId: context.session.user.id,
          conversationId: data.conversationId,
        }),
      ),
    ),
  );

export const restoreConversation = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(ConversationRestoreInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      ChatService.use((chat) =>
        chat.restoreConversation({
          userId: context.session.user.id,
          conversationId: data.conversationId,
          mark: data.mark,
        }),
      ),
    ),
  );

export const updateWorkSettings = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(UpdateWorkSettingsInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      ChatService.use((chat) =>
        chat.updateWorkSettings({
          userId: context.session.user.id,
          conversationId: data.conversationId,
          permissionLevel: data.permissionLevel,
        }),
      ).pipe(Effect.catchTags({ ConversationNotFound: missing, InvalidMessage: rejected })),
    ),
  );

export const renameConversation = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(RenameConversationInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      ChatService.use((chat) =>
        chat.renameConversation({
          userId: context.session.user.id,
          conversationId: data.conversationId,
          title: data.title,
        }),
      ).pipe(Effect.catchTag("ConversationNotFound", missing)),
    ),
  );

export const markConversationRead = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(ConversationIdInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      ChatService.use((chat) =>
        chat.markRead({ userId: context.session.user.id, conversationId: data.conversationId }),
      ),
    ),
  );

export const keepConversation = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(ConversationIdInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      ChatService.use((chat) =>
        chat.keepConversation({
          userId: context.session.user.id,
          conversationId: data.conversationId,
        }),
      ).pipe(Effect.catchTag("ConversationNotFound", missing)),
    ),
  );

export const setConversationArchived = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(ConversationArchiveInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      ChatService.use((chat) =>
        chat.setArchived({
          userId: context.session.user.id,
          conversationId: data.conversationId,
          archived: data.archived,
        }),
      ).pipe(Effect.catchTag("ConversationNotFound", missing)),
    ),
  );

export const archiveAllConversations = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runtime.runPromise(
      ChatService.use((chat) => chat.archiveAll({ userId: context.session.user.id })),
    ),
  );

export const listArchivedConversations = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runtime.runPromise(
      ChatService.use((chat) => chat.listArchived({ userId: context.session.user.id })).pipe(
        Effect.map((rows) =>
          rows.map((row) => ({ ...row, archivedAt: row.archivedAt.toISOString() })),
        ),
      ),
    ),
  );

export const listChatModels = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runtime.runPromise(
      // Filtered to what THIS user may see: public models plus private ones
      // shared with a group they belong to (admins see everything). The rows
      // carry the provider's display name, which the picker groups by.
      ProviderRepo.use((repo) => repo.listChatModelsFor(context.session.user.id)),
    ),
  );

/**
 * Saves a ```ui block's state. A refused save is not an error to the reader:
 * the answer moved on (retry, edit) or the block is not the one stored.
 */
export const saveUiState = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(SaveUiStateInput))
  .handler(({ data, context }) => {
    let state: JsonValue;
    try {
      state = JSON.parse(data.state);
    } catch {
      return { saved: false };
    }
    if (typeof state !== "object" || state === null || Array.isArray(state))
      return { saved: false };
    return runtime.runPromise(
      ChatRepo.use((repo) =>
        repo.saveUiState({
          userId: context.session.user.id,
          messageId: data.messageId,
          generationId: data.generationId,
          ordinal: data.ordinal,
          sourceHash: data.sourceHash,
          state,
          digest: data.digest,
        }),
      ).pipe(Effect.map((outcome) => ({ saved: outcome === "saved" }))),
    );
  });

/** Readers with a map lookup in flight: one each, so edits cannot queue a burst upstream. */
const mapLookupsInFlight = new Set<string>();

/**
 * Looks up the places and routes a finished answer's map computes from its
 * state. Null lookups when refused or busy; the page then shows what it has.
 */
export const lookupUiMap = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(LookupUiMapInput))
  .handler(async ({ data, context }) => {
    const userId = context.session.user.id;
    if (mapLookupsInFlight.has(userId)) return { lookups: null, busy: true };
    mapLookupsInFlight.add(userId);
    try {
      const lookups = await runtime.runPromise(
        Effect.gen(function* () {
          const repo = yield* ChatRepo;
          const target = yield* repo.uiBlockForLookups({ userId, ...data });
          if (!target) return null;
          const tools = yield* ToolsRepo;
          const maps = readMaps(yield* tools.getTool(MAPS_TOOL));
          const services = yield* MapLookups;
          const found = yield* resolvePageLookups(
            {
              off: !maps.enabled,
              code: target.code,
              existing: target.lookups,
              geocode: (query) => services.geocode(maps.services, query),
              route: (mode, stops) => services.route(maps.services, mode, stops),
            },
            data,
          );
          if (Object.keys(found.places).length === 0 && Object.keys(found.routes).length === 0)
            return target.lookups;
          return yield* repo.recordPageLookups({
            userId,
            messageId: data.messageId,
            generationId: data.generationId,
            ...found,
          });
        }),
      );
      return { lookups, busy: false };
    } finally {
      mapLookupsInFlight.delete(userId);
    }
  });
