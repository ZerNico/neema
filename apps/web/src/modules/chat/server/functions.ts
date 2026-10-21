import { notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { UsageLimits } from "~/modules/limits/server/service.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { refuse, type RefusalOverrides } from "~/server/refusal.ts";
import { runServerFn } from "~/server/run-server-fn.ts";
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
import { ChatService } from "./service.ts";
import type { DesktopFolderRef } from "./attempt-options.ts";

const standard = Schema.toStandardSchemaV1;

const CONVERSATIONS_DEFAULT_LIMIT = 30;

export const listConversations = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(standard(ListConversationsInput))
  .handler(({ data, context }) =>
    runServerFn(
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
    runServerFn(
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
    runServerFn(
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
    runServerFn(
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
  runServerFn(
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
    ),
    chosenNow,
  );

export const sendMessage = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(SendMessageInput))
  .handler(({ data, context }) => startTurn(data, context.session));

export const reserveWorkTurn = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(ReserveWorkTurnInput))
  .handler(({ data, context }) =>
    runServerFn(
      ChatService.use((chat) =>
        chat.reserveWorkTurn({
          id: data.reservationId,
          userId: context.session.user.id,
          conversation: data.conversation,
        }),
      ),
      {
        // Not the message's fault: the reservation no longer fits this chat.
        InvalidMessage: (error) => ({ status: 409, body: error.reason }),
      },
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
    runServerFn(
      ChatService.use((chat) =>
        chat.getWorkTurnReservation({
          userId: context.session.user.id,
          reservationId: data.reservationId,
        }),
      ),
    ),
  );

export const abortWorkTurn = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(WorkTurnReservationInput))
  .handler(({ data, context }) =>
    runServerFn(
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

// The refusal table words most of a message's failures. Here only what the
// chat surfaces say differently: a new message picks its agent, collections
// and skills now; a continuing one reuses what its answers used, which may
// have gone since.
const gone = (body: string) => () => ({ status: 409, body });
// Claimed by another message, or gone. The chip is stale either way.
const attachmentGone = gone("An attachment is no longer available");
const chosenNow: RefusalOverrides = {
  AgentNotAvailable: () => ({ status: 404, body: "The selected agent is not available" }),
  IntegrationNotAvailable: () => ({
    status: 404,
    body: "A selected integration is not available",
  }),
  KnowledgeNotAvailable: () => ({ status: 404, body: "A selected collection is not available" }),
  SkillNotAvailable: () => ({ status: 404, body: "A selected skill is not available" }),
  AttachmentNotAvailable: attachmentGone,
};
const usedBefore: RefusalOverrides = {
  AgentNotAvailable: gone("This chat’s agent is no longer available"),
  IntegrationNotAvailable: gone("An integration this answer used is no longer available"),
  KnowledgeNotAvailable: gone("Knowledge this answer used is no longer available"),
  SkillNotAvailable: gone("A skill this answer used is no longer available"),
  AttachmentNotAvailable: attachmentGone,
};
const notStarted = () => refuse(409, "This message could not be started");

export const queueMessage = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(QueueMessageInput))
  .handler(({ data, context }) =>
    runServerFn(
      ChatService.use((chat) => chat.queueMessage(queueSubmission(data, context.session))),
      { AttachmentNotAvailable: attachmentGone },
    ),
  );

export const replaceQueuedMessage = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(ReplaceQueueEntryInput))
  .handler(({ data, context }) =>
    runServerFn(
      ChatService.use((chat) =>
        chat.replaceQueuedMessage({
          ...queueSubmission(data, context.session),
          entryId: data.entryId,
        }),
      ),
      { AttachmentNotAvailable: attachmentGone },
    ),
  );

export const removeQueuedMessage = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(QueueEntryIdInput))
  .handler(({ data, context }) =>
    runServerFn(
      ChatService.use((chat) =>
        chat.removeQueuedMessage({ userId: context.session.user.id, ...data }),
      ),
    ),
  );

export const steerQueuedMessage = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(SteerQueueEntryInput))
  .handler(({ data, context }) =>
    runServerFn(
      ChatService.use((chat) =>
        chat.steerQueuedMessage({ userId: context.session.user.id, ...data }),
      ),
      {
        QueueEntryNotFound: gone("Queued message no longer exists"),
        AttachmentUnsupported: (error) => ({
          status: 400,
          body: `The running answer can’t read ${error.fileName}: ${error.reason}`,
        }),
      },
    ),
  );

export const dispatchQueuedMessage = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(DispatchQueueInput))
  .handler(({ data, context }) =>
    runServerFn(
      ChatService.use((chat) =>
        chat.dispatchQueuedMessage({
          userId: context.session.user.id,
          conversationId: data.conversationId,
          force: data.force,
          desktop: desktopDispatch(data, context.session.session.id),
        }),
      ).pipe(
        // Other resolution failures read the same to a person: the queued
        // message cannot start right now and is kept for them to decide on.
        Effect.catch((error) =>
          error._tag === "AccountIneligible" || error._tag === "ConversationNotFound"
            ? Effect.fail(error)
            : notStarted(),
        ),
      ),
    ),
  );

export const sendQueuedNow = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(SendQueuedNowInput))
  .handler(({ data, context }) =>
    runServerFn(
      ChatService.use((chat) =>
        chat.sendQueuedNow({
          userId: context.session.user.id,
          conversationId: data.conversationId,
          entryId: data.entryId,
          desktop: desktopDispatch(data, context.session.session.id),
        }),
      ).pipe(
        // The reason is already on the entry; the person sees it in the strip.
        Effect.catch((error) =>
          error._tag === "AccountIneligible" ||
          error._tag === "ConversationNotFound" ||
          error._tag === "MessageNotFound"
            ? Effect.fail(error)
            : notStarted(),
        ),
      ),
    ),
  );

export const answerQuestion = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(AnswerQuestionInput))
  .handler(({ data, context }) =>
    runServerFn(
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
      ),
      usedBefore,
    ),
  );

export const retryMessage = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(RetryMessageInput))
  .handler(({ data, context }) =>
    runServerFn(
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
      ),
      usedBefore,
    ),
  );

export const resumeMessage = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(ResumeMessageInput))
  .handler(({ data, context }) =>
    runServerFn(
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
      ),
      usedBefore,
    ),
  );

export const branchConversation = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(BranchConversationInput))
  .handler(({ data, context }) =>
    runServerFn(
      ChatService.use((chat) =>
        chat.branchConversation({
          userId: context.session.user.id,
          conversationId: data.conversationId,
          messageId: data.messageId,
        }),
      ),
    ),
  );

export const stopGeneration = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(MessageIdInput))
  .handler(({ data, context }) =>
    runServerFn(
      ChatService.use((chat) =>
        chat.stopGeneration({
          generationId: data.generationId,
          userId: context.session.user.id,
          conversationId: data.conversationId,
          messageId: data.messageId,
        }),
      ),
    ),
  );

export const editMessage = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(EditMessageInput))
  .handler(({ data, context }) =>
    runServerFn(
      ChatService.use((chat) =>
        chat.editMessage({
          ...data,
          userId: context.session.user.id,
          deviceSessionId: context.session.session.id,
        }),
      ),
      usedBefore,
    ),
  );

export const deleteConversation = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(ConversationIdInput))
  .handler(({ data, context }) =>
    runServerFn(
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
    runServerFn(
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
    runServerFn(
      ChatService.use((chat) =>
        chat.updateWorkSettings({
          userId: context.session.user.id,
          conversationId: data.conversationId,
          permissionLevel: data.permissionLevel,
        }),
      ),
    ),
  );

export const renameConversation = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(RenameConversationInput))
  .handler(({ data, context }) =>
    runServerFn(
      ChatService.use((chat) =>
        chat.renameConversation({
          userId: context.session.user.id,
          conversationId: data.conversationId,
          title: data.title,
        }),
      ),
    ),
  );

export const markConversationRead = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(ConversationIdInput))
  .handler(({ data, context }) =>
    runServerFn(
      ChatService.use((chat) =>
        chat.markRead({ userId: context.session.user.id, conversationId: data.conversationId }),
      ),
    ),
  );

export const keepConversation = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(ConversationIdInput))
  .handler(({ data, context }) =>
    runServerFn(
      ChatService.use((chat) =>
        chat.keepConversation({
          userId: context.session.user.id,
          conversationId: data.conversationId,
        }),
      ),
    ),
  );

export const setConversationArchived = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(ConversationArchiveInput))
  .handler(({ data, context }) =>
    runServerFn(
      ChatService.use((chat) =>
        chat.setArchived({
          userId: context.session.user.id,
          conversationId: data.conversationId,
          archived: data.archived,
        }),
      ),
    ),
  );

export const archiveAllConversations = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runServerFn(ChatService.use((chat) => chat.archiveAll({ userId: context.session.user.id }))),
  );

export const listArchivedConversations = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runServerFn(
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
    runServerFn(
      // Filtered to what THIS user may see: public models plus private ones
      // shared with a group they belong to (admins see everything). The rows
      // carry the provider's display name, which the picker groups by.
      Effect.all({
        models: ProviderRepo.use((repo) => repo.listChatModelsFor(context.session.user.id)),
        standing: UsageLimits.use((limits) => limits.standing(context.session.user.id)),
      }).pipe(
        Effect.map(({ models, standing }) =>
          models.map((model) => {
            // Open again once every used-up limit covering it has reset.
            const reached = standing.filter(
              (limit) =>
                limit.reached &&
                (limit.models === null || limit.models.some((entry) => entry.id === model.id)),
            );
            return {
              ...model,
              limitedUntil: reached.length
                ? reached
                    .map((limit) => limit.resetsAt)
                    .toSorted()
                    .at(-1)!
                : null,
            };
          }),
        ),
      ),
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
    return runServerFn(
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
      const lookups = await runServerFn(
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
