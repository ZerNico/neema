import { notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { runtime } from "~/server/runtime.ts";
import {
  AnswerQuestionInput,
  BranchConversationInput,
  ConversationArchiveInput,
  ConversationDetailInput,
  ConversationHistoryInput,
  ConversationIdInput,
  EditMessageInput,
  ListConversationsInput,
  MessageIdInput,
  RenameConversationInput,
  ReserveWorkTurnInput,
  WorkTurnReservationInput,
  ActivateWorkTurnInput,
  UpdateWorkSettingsInput,
  RetryMessageInput,
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

export const sendMessage = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(SendMessageInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      ChatService.use((chat) =>
        chat.sendMessage({
          userId: context.session.user.id,
          conversation: data.conversation,
          modelId: data.modelId,
          reasoningEffort: data.reasoningEffort,
          content: data.content,
          researchEnabled: data.researchEnabled,
          searchEnabled: data.searchEnabled,
          desktopFolders: data.desktopFolders,
          desktopCommands: data.desktopCommands,
          fromDesktop: data.fromDesktop,
          desktopExecutorId: data.desktopExecutorId,
          desktopMachineId: data.desktopMachineId,
          desktopMachineName: data.desktopMachineName,
          workspaceFiles: data.workspaceFiles,
          deviceSessionId: context.session.session.id,
          timeZone: data.timeZone,
          openDocumentId: data.openDocumentId,
          attachmentIds: data.attachmentIds,
          agentId: data.agentId,
          collectionIds: data.collectionIds,
          skillIds: data.skillIds,
          integrationChoices: data.integrationChoices,
        }),
      ).pipe(
        Effect.catchTags({
          AgentNotAvailable: () =>
            Effect.die(new Response("The selected agent is not available", { status: 404 })),
          WorkDesktopRequired: () =>
            Effect.die(
              new Response("This is a work chat; continue it from the desktop app", {
                status: 409,
              }),
            ),
          KnowledgeNotAvailable: () =>
            Effect.die(new Response("A selected collection is not available", { status: 404 })),
          KnowledgeRejected: (e) => Effect.die(new Response(e.reason, { status: 400 })),
          ModelNotFound: () => Effect.die(new Response("Unknown model", { status: 400 })),
          ConversationNotFound: () => Effect.die(new Response("Not found", { status: 404 })),
          ConversationBusy: () =>
            Effect.die(new Response("A response is still generating", { status: 409 })),
          ToolUnavailable: (e) =>
            Effect.die(new Response(`Web search unavailable: ${e.reason}`, { status: 400 })),
          InvalidMessage: (e) => Effect.die(new Response(e.reason, { status: 400 })),
          AttachmentUnsupported: (e) =>
            Effect.die(new Response(`${e.fileName}: ${e.reason}`, { status: 400 })),
          // Claimed by another message, or gone. The chip is stale either way.
          AttachmentNotAvailable: () =>
            Effect.die(new Response("An attachment is no longer available", { status: 409 })),
        }),
      ),
    ),
  );

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
          ConversationNotFound: () => Effect.die(new Response("Not found", { status: 404 })),
          ConversationBusy: () =>
            Effect.die(new Response("This conversation is busy", { status: 409 })),
          InvalidMessage: (e) => Effect.die(new Response(e.reason, { status: 409 })),
        }),
      ),
    ),
  );

export const activateWorkTurn = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(ActivateWorkTurnInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      ChatService.use((chat) =>
        chat.sendMessage({
          userId: context.session.user.id,
          reservationId: data.reservationId,
          conversation: data.conversation,
          modelId: data.modelId,
          reasoningEffort: data.reasoningEffort,
          content: data.content,
          researchEnabled: data.researchEnabled,
          searchEnabled: data.searchEnabled,
          desktopFolders: data.desktopFolders,
          desktopCommands: data.desktopCommands,
          fromDesktop: data.fromDesktop,
          desktopExecutorId: data.desktopExecutorId,
          desktopMachineId: data.desktopMachineId,
          desktopMachineName: data.desktopMachineName,
          workspaceFiles: data.workspaceFiles,
          deviceSessionId: context.session.session.id,
          timeZone: data.timeZone,
          openDocumentId: data.openDocumentId,
          attachmentIds: data.attachmentIds,
          agentId: data.agentId,
          collectionIds: data.collectionIds,
          skillIds: data.skillIds,
          integrationChoices: data.integrationChoices,
        }),
      ).pipe(
        Effect.catchTags({
          AgentNotAvailable: () =>
            Effect.die(new Response("The selected agent is not available", { status: 404 })),
          WorkDesktopRequired: () =>
            Effect.die(
              new Response("This is a work chat; continue it from the desktop app", {
                status: 409,
              }),
            ),
          KnowledgeNotAvailable: () =>
            Effect.die(new Response("A selected collection is not available", { status: 404 })),
          KnowledgeRejected: (e) => Effect.die(new Response(e.reason, { status: 400 })),
          ModelNotFound: () => Effect.die(new Response("Unknown model", { status: 400 })),
          ConversationNotFound: () => Effect.die(new Response("Not found", { status: 404 })),
          ConversationBusy: () =>
            Effect.die(new Response("This conversation is busy", { status: 409 })),
          ToolUnavailable: (e) =>
            Effect.die(new Response(`Web search unavailable: ${e.reason}`, { status: 400 })),
          InvalidMessage: (e) => Effect.die(new Response(e.reason, { status: 400 })),
          AttachmentUnsupported: (e) =>
            Effect.die(new Response(`${e.fileName}: ${e.reason}`, { status: 400 })),
          AttachmentNotAvailable: () =>
            Effect.die(new Response("An attachment is no longer available", { status: 409 })),
        }),
      ),
    ),
  );

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
      ).pipe(
        Effect.catchTag("ConversationNotFound", () =>
          Effect.die(new Response("Not found", { status: 404 })),
        ),
      ),
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
      ),
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
    ...(data.reasoningEffort !== undefined ? { reasoningEffort: data.reasoningEffort } : {}),
    searchEnabled: data.searchEnabled,
    researchEnabled: data.researchEnabled,
    skillIds: data.skillIds,
    collectionIds: data.collectionIds,
    timeZone: data.timeZone,
    openDocumentId: data.openDocumentId,
  },
  desktop: desktopDispatch(data, session.session.id),
});

/** Only a request from the desktop app names a machine; anything else is none. */
const desktopDispatch = (
  data: {
    fromDesktop?: boolean;
    desktopFolders?: ReadonlyArray<DesktopFolderRef>;
    desktopCommands?: boolean;
    desktopExecutorId?: string;
  },
  deviceSessionId: string,
) =>
  data.fromDesktop && data.desktopExecutorId
    ? {
        fromDesktop: true,
        desktopFolders: data.desktopFolders,
        desktopCommands: data.desktopCommands,
        desktopExecutorId: data.desktopExecutorId,
        deviceSessionId,
      }
    : undefined;

const queueSubmissionErrors = {
  ConversationNotFound: () => Effect.die(new Response("Not found", { status: 404 })),
  ModelNotFound: () => Effect.die(new Response("Unknown model", { status: 400 })),
  WorkDesktopRequired: () =>
    Effect.die(
      new Response("This is a work chat; continue it from the desktop app", { status: 409 }),
    ),
  ToolUnavailable: (error: { reason: string }) =>
    Effect.die(new Response(`Web search unavailable: ${error.reason}`, { status: 400 })),
  InvalidMessage: (error: { reason: string }) =>
    Effect.die(new Response(error.reason, { status: 400 })),
  AttachmentUnsupported: (error: { fileName: string; reason: string }) =>
    Effect.die(new Response(`${error.fileName}: ${error.reason}`, { status: 400 })),
  AttachmentNotAvailable: () =>
    Effect.die(new Response("An attachment is no longer available", { status: 409 })),
} as const;

export const queueMessage = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(QueueMessageInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      ChatService.use((chat) => chat.queueMessage(queueSubmission(data, context.session))).pipe(
        Effect.catchTags({
          ...queueSubmissionErrors,
          QueueFull: () =>
            Effect.die(new Response("Too many messages are queued", { status: 409 })),
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
          ...queueSubmissionErrors,
          QueueEntryNotFound: () =>
            Effect.die(
              new Response("This queued message already started or was removed", { status: 409 }),
            ),
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
      ).pipe(
        Effect.catchTag("ConversationNotFound", () =>
          Effect.die(new Response("Not found", { status: 404 })),
        ),
      ),
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
          ConversationNotFound: () => Effect.die(new Response("Not found", { status: 404 })),
          QueueEntryNotFound: () =>
            Effect.die(new Response("Queued message no longer exists", { status: 409 })),
          NoActiveGeneration: () =>
            Effect.die(new Response("That response already finished", { status: 409 })),
          AttachmentUnsupported: (error) =>
            Effect.die(
              new Response(`The running answer can’t read ${error.fileName}: ${error.reason}`, {
                status: 400,
              }),
            ),
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
        Effect.catchTag("ConversationNotFound", () =>
          Effect.die(new Response("Not found", { status: 404 })),
        ),
        // Every resolution failure reads the same to a person: the queued
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
          ConversationNotFound: () => Effect.die(new Response("Not found", { status: 404 })),
          MessageNotFound: () => Effect.die(new Response("Not found", { status: 404 })),
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
          fromDesktop: data.fromDesktop,
          desktopExecutorId: data.desktopExecutorId,
          desktopMachineId: data.desktopMachineId,
          desktopMachineName: data.desktopMachineName,
          deviceSessionId: context.session.session.id,
          timeZone: data.timeZone,
          openDocumentId: data.openDocumentId,
          attachmentIds: [],
          questionResponse: { callId: data.callId, response: data.response },
          reasoningEffort: data.reasoningEffort,
        }),
      ).pipe(
        Effect.catchTags({
          AgentNotAvailable: () =>
            Effect.die(new Response("This chat’s agent is no longer available", { status: 409 })),
          WorkDesktopRequired: () =>
            Effect.die(
              new Response("This is a work chat; continue it from the desktop app", {
                status: 409,
              }),
            ),
          KnowledgeNotAvailable: () =>
            Effect.die(
              new Response("Knowledge this answer used is no longer available", { status: 409 }),
            ),
          KnowledgeRejected: (e) => Effect.die(new Response(e.reason, { status: 400 })),
          QuestionUnavailable: () =>
            Effect.die(
              new Response("These questions are no longer available. Refresh the conversation.", {
                status: 409,
              }),
            ),
          ConversationBusy: () =>
            Effect.die(new Response("A response is still generating", { status: 409 })),
          ConversationNotFound: () => Effect.die(new Response("Not found", { status: 404 })),
          ModelNotFound: () => Effect.die(new Response("Unknown model", { status: 400 })),
          ToolUnavailable: (e) =>
            Effect.die(new Response(`Web search unavailable: ${e.reason}`, { status: 400 })),
          InvalidMessage: (e) => Effect.die(new Response(e.reason, { status: 400 })),
          AttachmentNotAvailable: () =>
            Effect.die(new Response("Attachment unavailable", { status: 409 })),
          AttachmentUnsupported: (e) => Effect.die(new Response(e.reason, { status: 400 })),
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
          userId: context.session.user.id,
          conversationId: data.conversationId,
          messageId: data.messageId,
          modelId: data.modelId,
          timeZone: data.timeZone,
          openDocumentId: data.openDocumentId,
        }),
      ).pipe(
        Effect.catchTags({
          ConversationNotFound: () => Effect.die(new Response("Not found", { status: 404 })),
          MessageNotFound: () => Effect.die(new Response("Not found", { status: 404 })),
          ModelNotFound: () => Effect.die(new Response("Unknown model", { status: 400 })),
          RetryNotAllowed: (e) => Effect.die(new Response(e.reason, { status: 409 })),
          ConversationBusy: () =>
            Effect.die(new Response("This conversation is busy", { status: 409 })),
          InvalidMessage: (e) => Effect.die(new Response(e.reason, { status: 400 })),
          AttachmentNotAvailable: () =>
            Effect.die(new Response("An attachment is no longer available", { status: 409 })),
          AttachmentUnsupported: (e) =>
            Effect.die(new Response(`${e.fileName}: ${e.reason}`, { status: 400 })),
          AgentNotAvailable: () =>
            Effect.die(new Response("This chat’s agent is no longer available", { status: 409 })),
          WorkDesktopRequired: () =>
            Effect.die(
              new Response("This is a work chat; continue it from the desktop app", {
                status: 409,
              }),
            ),
          KnowledgeRejected: (e) => Effect.die(new Response(e.reason, { status: 400 })),
          KnowledgeNotAvailable: () =>
            Effect.die(
              new Response("Knowledge this answer used is no longer available", { status: 409 }),
            ),
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
          ConversationNotFound: () => Effect.die(new Response("Not found", { status: 404 })),
          MessageNotFound: () => Effect.die(new Response("Not found", { status: 404 })),
          BranchNotAllowed: (e) => Effect.die(new Response(e.reason, { status: 409 })),
          ConversationBusy: () =>
            Effect.die(new Response("This conversation is busy", { status: 409 })),
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
      ).pipe(
        Effect.catchTags({
          ConversationNotFound: () => Effect.die(new Response("Not found", { status: 404 })),
          MessageNotFound: () => Effect.die(new Response("Not found", { status: 404 })),
        }),
      ),
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
          AgentNotAvailable: () =>
            Effect.die(new Response("This chat’s agent is no longer available", { status: 409 })),
          WorkDesktopRequired: () =>
            Effect.die(
              new Response("This is a work chat; continue it from the desktop app", {
                status: 409,
              }),
            ),
          KnowledgeNotAvailable: () =>
            Effect.die(
              new Response("Knowledge this answer used is no longer available", { status: 409 }),
            ),
          KnowledgeRejected: (e) => Effect.die(new Response(e.reason, { status: 400 })),
          ConversationNotFound: () => Effect.die(new Response("Not found", { status: 404 })),
          MessageNotFound: () => Effect.die(new Response("Not found", { status: 404 })),
          ModelNotFound: () => Effect.die(new Response("Unknown model", { status: 400 })),
          ToolUnavailable: (e) =>
            Effect.die(new Response(`Web search unavailable: ${e.reason}`, { status: 400 })),
          EditNotAllowed: (e) => Effect.die(new Response(e.reason, { status: 409 })),
          ConversationBusy: () =>
            Effect.die(new Response("This conversation is busy", { status: 409 })),
          InvalidMessage: (e) => Effect.die(new Response(e.reason, { status: 400 })),
          AttachmentUnsupported: (e) =>
            Effect.die(new Response(`${e.fileName}: ${e.reason}`, { status: 400 })),
          AttachmentNotAvailable: () =>
            Effect.die(new Response("An attachment is no longer available", { status: 409 })),
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
      ).pipe(
        Effect.catchTags({
          ConversationNotFound: () => Effect.die(new Response("Not found", { status: 404 })),
          InvalidMessage: (e) => Effect.die(new Response(e.reason, { status: 400 })),
        }),
      ),
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
      ).pipe(
        Effect.catchTag("ConversationNotFound", () =>
          Effect.die(new Response("Not found", { status: 404 })),
        ),
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
      ).pipe(
        Effect.catchTag("ConversationNotFound", () =>
          Effect.die(new Response("Not found", { status: 404 })),
        ),
      ),
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
      ).pipe(
        Effect.catchTag("ConversationNotFound", () =>
          Effect.die(new Response("Not found", { status: 404 })),
        ),
      ),
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
