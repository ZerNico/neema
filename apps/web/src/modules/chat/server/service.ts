import { LanguageRepo } from "~/modules/language/server/repo.ts";
import { m } from "~/paraglide/messages.js";
import { localized } from "~/i18n/localized.ts";
import { IntegrationRepo } from "~/modules/integrations/server/repo.ts";
import type { DesktopSubmission, OpenDocument } from "../schema.ts";
import type { SkillNotAvailable, SkillRejected } from "~/modules/skills/errors.ts";
import { Context, Effect, Layer } from "effect";
import { uuidv7 } from "uuidv7";
import {
  BranchNotAllowed,
  ConversationBusy,
  ConversationNotFound,
  EditNotAllowed,
  InvalidMessage,
  MessageNotFound,
  ModelNotFound,
  RetryNotAllowed,
  ResumeNotAllowed,
  QuestionUnavailable,
  QueueEntryNotFound,
  QueueFull,
  NoActiveGeneration,
  WorkDesktopRequired,
} from "~/modules/chat/errors.ts";
import { AnalyticsRepo } from "~/modules/analytics/server/repo.ts";
import { AttachmentNotAvailable, AttachmentUnsupported } from "~/modules/attachments/errors.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { AiGateway } from "~/modules/providers/server/gateway.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import type { ReasoningEffort } from "~/modules/providers/model-config.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { ToolUnavailable } from "~/modules/tools/server/web-search.ts";
import { AgentNotAvailable } from "~/modules/agents/errors.ts";
import { KnowledgeNotAvailable, KnowledgeRejected } from "~/modules/knowledge/errors.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { Db } from "~/server/db.ts";
import { agents as savedAgents } from "~/db/schema/index.ts";
import { eq } from "drizzle-orm";
import {
  ChatRepo,
  type EditContent,
  type HistorySnapshot,
  type MessageRow,
  type TurnContent,
  type TurnFields,
  type ResolveError,
  type WorkTurnReservationRow,
} from "./repo.ts";
import { resumeFirstTurn } from "./prompt.ts";
import { RESEARCH_TURN_BASE } from "./research/execution.ts";
import { ConversationSweepInterval, QueueSweepInterval } from "./generation-fence.ts";
import { fallbackTitle, generateConversationTitle, type TitleDeps } from "./title.ts";
import type { IntegrationGrant } from "~/modules/integrations/grant.ts";
import { makeAttemptOptions } from "./attempt-options.ts";
import { makeConversationLifecycle } from "./conversation-lifecycle.ts";
import {
  makeQueueService,
  type QueueSubmission,
  type QueueSubmissionError,
} from "./queue-service.ts";

// Omit on the whole input would flatten the content/question-response union;
// keep the discriminant intact by omitting from the plain fields only.
/**
 * A message with the composer's toggles, or an answer to an `ask_user` batch,
 * which keeps the asking attempt's and submits none.
 */
type SendContent =
  | { content: string; questionResponse?: never; searchEnabled: boolean; researchEnabled: boolean }
  | {
      content?: never;
      questionResponse: Extract<TurnContent, { questionResponse: object }>["questionResponse"];
      searchEnabled?: never;
      researchEnabled?: never;
    };

/**
 * What an edit submits: new text with the composer's toggles and selection, or
 * new answers to an `ask_user` batch, which keep the asking attempt's.
 */
type EditChoices =
  | {
      content: string;
      questionResponse?: never;
      searchEnabled: boolean;
      researchEnabled: boolean;
      /** Omitted keeps the attempt's saved selection; sent replaces it. */
      skillIds?: ReadonlyArray<string> | undefined;
      collectionIds?: ReadonlyArray<string> | undefined;
    }
  | {
      content?: never;
      questionResponse: Extract<EditContent, { questionResponse: object }>["questionResponse"];
      searchEnabled?: never;
      researchEnabled?: never;
      skillIds?: never;
      collectionIds?: never;
    };

type SendTurnInput = Omit<TurnFields, "associateAgentId" | "resolve" | "saveIntegrationChoices"> &
  SendContent & {
    /** Integration toggles made in the composer before this chat existed. */
    integrationChoices?: ReadonlyArray<{ connectionId: string; enabled: boolean }> | undefined;
    reasoningEffort?: ReasoningEffort | null | undefined;
    /** What the desktop app reports about the machine this send came from. */
    desktop?: DesktopSubmission | undefined;
    /**
     * Basenames of files the composer copied into the chat's workspace for
     * this send. Stored on the attempt's generation config; the transcript
     * renders them as chips, never as message text.
     */
    workspaceFiles?: ReadonlyArray<string> | undefined;
    /** See `ExternalOwner.deviceSessionId`; read from the session, never the body. */
    deviceSessionId?: string | undefined;
    timeZone?: string | undefined;
    /** The document open in the panel; the model reads it first. */
    openDocument?: OpenDocument | undefined;
    /** See chat/schema.ts `generationFields.agentId`. */
    agentId?: string | null | undefined;
    /** The composer's image model; absent keeps the chat's own. */
    imageModelId?: string | null | undefined;
  };

/** What the page learns of a Work turn reservation. */
const reservationView = (row: WorkTurnReservationRow) => ({
  reservationId: row.id,
  conversationId: row.conversationId,
  status: row.status,
  assistantMessageId: row.assistantMessageId,
});
type WorkTurnReservationView = ReturnType<typeof reservationView>;

/** Orchestrates the chat use-cases on top of repo + stream engine + sync bus. */
/** The question a turn answers: the last user message before it, past steers. */
const turnQuestionIds = (before: ReadonlyArray<MessageRow>) => {
  const question = before.findLast((row) => row.role === "user" && !row.steeredIntoMessageId);
  return question ? [question.id] : [];
};

export class ChatService extends Context.Service<
  ChatService,
  {
    reserveWorkTurn(input: {
      id: string;
      userId: string;
      conversation: TurnFields["conversation"];
    }): Effect.Effect<
      { reservationId: string; conversationId: string },
      ConversationNotFound | ConversationBusy | InvalidMessage
    >;
    getWorkTurnReservation(input: {
      userId: string;
      reservationId: string;
    }): Effect.Effect<WorkTurnReservationView, ConversationNotFound>;
    /** Answers with the state the reservation is left in, which may be activated. */
    abortWorkTurn(input: {
      userId: string;
      reservationId: string;
    }): Effect.Effect<WorkTurnReservationView, ConversationNotFound>;
    sendMessage(
      input: SendTurnInput,
    ): Effect.Effect<
      { conversationId: string; assistantMessageId: string; generationId: string | null },
      | ModelNotFound
      | ConversationNotFound
      | ConversationBusy
      | QuestionUnavailable
      | ToolUnavailable
      | InvalidMessage
      | AttachmentNotAvailable
      | AttachmentUnsupported
      | AgentNotAvailable
      | WorkDesktopRequired
      | SkillNotAvailable
      | SkillRejected
      | KnowledgeNotAvailable
      | KnowledgeRejected
      | ResolveError
    >;
    queueMessage(
      input: QueueSubmission,
    ): Effect.Effect<{ entryId: string }, QueueSubmissionError | ConversationNotFound | QueueFull>;
    /** Rewrites a queued message in place; see `ChatRepo.replaceQueueEntry`. */
    replaceQueuedMessage(
      input: QueueSubmission & { entryId: string },
    ): Effect.Effect<void, QueueSubmissionError | ConversationNotFound | QueueEntryNotFound>;
    removeQueuedMessage(input: {
      userId: string;
      conversationId: string;
      entryId: string;
    }): Effect.Effect<void, ConversationNotFound>;
    steerQueuedMessage(input: {
      userId: string;
      conversationId: string;
      entryId: string;
      messageId: string;
      generationId: string;
    }): Effect.Effect<
      void,
      ConversationNotFound | QueueEntryNotFound | NoActiveGeneration | AttachmentUnsupported
    >;
    /**
     * Starts the next queued message. A Work chat's entry needs `desktop`: the
     * fresh report of the app dispatching it. Without one it waits, since the
     * server cannot name a live machine on its own.
     */
    dispatchQueuedMessage(input: {
      userId: string;
      conversationId: string;
      force?: boolean | undefined;
      /** Start this entry rather than the head; see `sendQueuedNow`. */
      entryId?: string | undefined;
      desktop?: DesktopSubmission | undefined;
      deviceSessionId?: string | undefined;
    }): Effect.Effect<
      { started: boolean },
      | ConversationNotFound
      | ModelNotFound
      | ToolUnavailable
      | AttachmentNotAvailable
      | AttachmentUnsupported
      | ResolveError
    >;
    /**
     * Sends one queued message now, whatever its place. A running answer is
     * stopped first, keeping what it wrote, and the entry starts once that
     * answer has settled; a paused queue just starts it.
     */
    sendQueuedNow(input: {
      userId: string;
      conversationId: string;
      entryId: string;
      desktop?: DesktopSubmission | undefined;
      deviceSessionId?: string | undefined;
    }): Effect.Effect<
      { started: boolean },
      | ConversationNotFound
      | MessageNotFound
      | ModelNotFound
      | ToolUnavailable
      | AttachmentNotAvailable
      | AttachmentUnsupported
      | ResolveError
    >;
    /**
     * Regenerates an assistant message in place (same id, fresh stream),
     * deleting every message after it. Retry rewinds the conversation.
     */
    retryMessage(input: {
      desktop?: DesktopSubmission | undefined;
      userId: string;
      conversationId: string;
      messageId: string;
      /** Regenerate with this model instead of the one that answered before. */
      modelId?: string | undefined;
      /** Draw with this image model from now on; absent keeps the chat's own. */
      imageModelId?: string | null | undefined;
      deviceSessionId?: string | undefined;
      timeZone?: string | undefined;
      openDocument?: OpenDocument | undefined;
    }): Effect.Effect<
      { assistantMessageId: string; generationId: string },
      | ConversationNotFound
      | MessageNotFound
      | ModelNotFound
      | RetryNotAllowed
      | ConversationBusy
      | AgentNotAvailable
      | WorkDesktopRequired
      | KnowledgeRejected
      | InvalidMessage
      | AttachmentNotAvailable
      | AttachmentUnsupported
      | SkillNotAvailable
      | SkillRejected
      | KnowledgeNotAvailable
      | ResolveError
    >;
    /**
     * Continues the last answer after it failed or was stopped: same message,
     * a new generation that starts from what the answer already produced.
     */
    resumeMessage(input: {
      desktop?: DesktopSubmission | undefined;
      userId: string;
      conversationId: string;
      messageId: string;
      /** Continue with this model instead of the one that answered before. */
      modelId?: string | undefined;
      deviceSessionId?: string | undefined;
      timeZone?: string | undefined;
      openDocument?: OpenDocument | undefined;
    }): Effect.Effect<
      { assistantMessageId: string },
      | ConversationNotFound
      | MessageNotFound
      | ModelNotFound
      | ResumeNotAllowed
      | ConversationBusy
      | AgentNotAvailable
      | WorkDesktopRequired
      | KnowledgeRejected
      | InvalidMessage
      | AttachmentNotAvailable
      | AttachmentUnsupported
      | SkillNotAvailable
      | SkillRejected
      | KnowledgeNotAvailable
      | ResolveError
    >;
    /**
     * Forks the conversation at an assistant message into a new one holding a
     * copy of everything up to it. The source is left untouched.
     */
    branchConversation(input: {
      userId: string;
      conversationId: string;
      messageId: string;
    }): Effect.Effect<
      { conversationId: string },
      ConversationNotFound | MessageNotFound | BranchNotAllowed | ConversationBusy
    >;
    editMessage(
      input: EditChoices & {
        userId: string;
        conversationId: string;
        messageId: string;
        modelId: string;
        reasoningEffort?: ReasoningEffort | null | undefined;
        desktop?: DesktopSubmission | undefined;
        deviceSessionId?: string | undefined;
        timeZone?: string | undefined;
        openDocument?: OpenDocument | undefined;
        attachmentIds: ReadonlyArray<string>;
        /** The composer's image model; absent keeps the chat's own. */
        imageModelId?: string | null | undefined;
      },
    ): Effect.Effect<
      { assistantMessageId: string },
      | ConversationNotFound
      | MessageNotFound
      | ModelNotFound
      | EditNotAllowed
      | ConversationBusy
      | ToolUnavailable
      | InvalidMessage
      | AttachmentNotAvailable
      | AttachmentUnsupported
      | AgentNotAvailable
      | WorkDesktopRequired
      | SkillNotAvailable
      | SkillRejected
      | KnowledgeNotAvailable
      | KnowledgeRejected
      | ResolveError
    >;
    /**
     * Winds a streaming assistant message down early, keeping the partial
     * answer. `stopped: false` means there was nothing to stop here.
     */
    stopGeneration(input: {
      generationId?: string | undefined;
      userId: string;
      conversationId: string;
      messageId: string;
    }): Effect.Effect<{ stopped: boolean }, ConversationNotFound | MessageNotFound>;
    /**
     * Deletes a chat the way Undo can reverse: gone for every reader until
     * the sweep purges it, with any answer still running stopped. Returns the
     * delete's mark for its Undo, or null when there was nothing to delete.
     */
    deleteConversation(input: {
      userId: string;
      conversationId: string;
    }): Effect.Effect<string | null>;
    /** Undoes the delete `mark` names. False once purged or deleted again. */
    restoreConversation(input: {
      userId: string;
      conversationId: string;
      mark: string;
    }): Effect.Effect<boolean>;
    /** Work-chat policy. Refused on a plain chat, where there is nothing to govern. */
    updateWorkSettings(input: {
      userId: string;
      conversationId: string;
      permissionLevel: "manual" | "auto" | "skip";
    }): Effect.Effect<void, ConversationNotFound | InvalidMessage>;
    renameConversation(input: {
      userId: string;
      conversationId: string;
      title: string;
    }): Effect.Effect<void, ConversationNotFound>;
    /** Its owner has seen a scheduled run's answer. Idempotent. */
    markRead(input: { userId: string; conversationId: string }): Effect.Effect<void>;
    /** Turns a temporary chat into an ordinary one. Idempotent. */
    keepConversation(input: {
      userId: string;
      conversationId: string;
    }): Effect.Effect<void, ConversationNotFound>;
    /** Archives or unarchives one chat. Idempotent. */
    setArchived(input: {
      userId: string;
      conversationId: string;
      archived: boolean;
    }): Effect.Effect<void, ConversationNotFound>;
    /** Archives every chat the sidebar lists. Returns how many. */
    archiveAll(input: { userId: string }): Effect.Effect<number>;
    listArchived(input: {
      userId: string;
    }): Effect.Effect<ReadonlyArray<{ id: string; title: string | null; archivedAt: Date }>>;
    /** One pass of the expired-chat sweep; exposed so tests need not wait for it. */
    sweepExpired(): Effect.Effect<void>;
    /**
     * Fires one schedule into a fresh conversation or an existing one.
     * Internal: no composer concerns (attachments, desktop, clarifications)
     * apply. A missing or inaccessible model falls back to the user's default;
     * a deleted agent degrades the fire to a plain chat with the schedule's own
     * selections. An existing chat keeps its own agent.
     */
    runScheduledTurn(input: {
      userId: string;
      scheduleId: string;
      scheduleRunId: string;
      prompt: string;
      modelId: string | null;
      agentId: string | null;
      imageModelId?: string | null;
      searchEnabled: boolean;
      researchEnabled: boolean;
      collectionIds: ReadonlyArray<string>;
      skillIds: ReadonlyArray<string>;
      integrationGrants: ReadonlyArray<IntegrationGrant>;
      timeZone: string;
      target: { kind: "new" } | { kind: "existing"; conversationId: string };
      /** Runs once the fire's answer has ended, however it ended. */
      onSettled: Effect.Effect<void>;
    }): Effect.Effect<
      { conversationId: string; assistantMessageId: string },
      | ModelNotFound
      | ConversationNotFound
      | ConversationBusy
      | ToolUnavailable
      | InvalidMessage
      | AttachmentNotAvailable
      | AttachmentUnsupported
      | AgentNotAvailable
      | WorkDesktopRequired
      | SkillNotAvailable
      | SkillRejected
      | KnowledgeNotAvailable
      | KnowledgeRejected
      | QuestionUnavailable
      | ResolveError
    >;
  }
>()("chat/chat/ChatService") {
  static readonly layer = Layer.effect(ChatService, makeChatService());
}

function makeChatService() {
  return Effect.gen(function* () {
    const db = yield* Db;
    const repo = yield* ChatRepo;
    const providers = yield* ProviderRepo;
    const sync = yield* SyncBus;
    const policy = yield* FeaturePolicy;
    // A new answer is a new message that is streaming: lists move the chat up
    // and mark it generating from these two, without re-reading every page.
    const announceStarted = (userId: string, conversationId: string, messageId: string) =>
      Effect.andThen(
        sync.publish(userId, { type: "message.created", conversationId, messageId }),
        sync.publish(userId, {
          type: "message.status",
          conversationId,
          messageId,
          status: "streaming",
        }),
      );
    const attachmentRepo = yield* AttachmentRepo;
    const attachmentService = yield* AttachmentService;
    const integrations = yield* IntegrationRepo;
    const gateway = yield* AiGateway;
    const analytics = yield* AnalyticsRepo;
    const language = yield* LanguageRepo;
    const titleDeps: TitleDeps = { gateway, repo, sync, providers, analytics, language };

    const options = yield* makeAttemptOptions;
    const { searchToolEnabled, validateGenerationOptions, validateAttachments, resolver } = options;
    const lifecycle = yield* makeConversationLifecycle;
    const queue = yield* makeQueueService({
      options,
      stopGeneration: lifecycle.stopGeneration,
      announceStarted,
    });
    const { startAttempt } = queue;

    const reserveWorkTurn = Effect.fn("ChatService.reserveWorkTurn")(function* (input: {
      id: string;
      userId: string;
      conversation: TurnFields["conversation"];
    }) {
      if (!(yield* policy.can(input.userId, "work")))
        return yield* new InvalidMessage({ reason: localized(m.chat_error_work_not_permitted) });
      const row = yield* repo.reserveWorkTurn(input);
      return { reservationId: row.id, conversationId: row.conversationId };
    });

    const getWorkTurnReservation = Effect.fn("ChatService.getWorkTurnReservation")(
      function* (input: { userId: string; reservationId: string }) {
        return reservationView(
          yield* repo.getWorkTurnReservation(input.userId, input.reservationId),
        );
      },
    );

    const abortWorkTurn = Effect.fn("ChatService.abortWorkTurn")(function* (input: {
      userId: string;
      reservationId: string;
    }) {
      return reservationView(yield* repo.abortWorkTurn(input.userId, input.reservationId));
    });

    const sendMessage = Effect.fn("ChatService.sendMessage")(function* (input: SendTurnInput) {
      // Dropped files count as content on their own: an import-only send is a
      // question with chips and no bubble. Both names and text, since the
      // composer trims text.
      const workspaceFiles = input.workspaceFiles ?? [];
      if (
        !input.questionResponse &&
        input.content.trim() === "" &&
        input.attachmentIds.length === 0 &&
        workspaceFiles.length === 0
      ) {
        return yield* new InvalidMessage({ reason: localized(m.chat_error_message_empty) });
      }
      // The server stays authoritative even when the composer hides the toggle.
      yield* repo.research?.reap() ?? Effect.void;
      if (input.questionResponse && input.conversation.kind === "existing")
        yield* repo.getConversation(input.userId, input.conversation.id);
      const { model, attachmentFileNames, researchEnabled } =
        yield* validateGenerationOptions(input);
      const searchAvailable = yield* searchToolEnabled;

      // A work chat's grants and folders live on the user's machine under its
      // id, so sweeping it away a day later would strand them.
      if (
        input.conversation.kind === "new" &&
        input.conversation.temporary &&
        input.conversation.mode === "work"
      )
        return yield* new InvalidMessage({
          reason: localized(m.chat_error_work_chat_not_temporary),
        });
      if (
        input.conversation.kind === "new" &&
        input.conversation.temporary &&
        input.conversation.projectId
      )
        return yield* new InvalidMessage({
          reason: localized(m.chat_error_temporary_chat_no_project),
        });

      // The association is fixed at creation; its configuration is live for
      // every subsequent attempt. Swapping or removal is not a chat setting.
      if (
        input.agentId !== undefined &&
        input.conversation.kind === "existing" &&
        !input.questionResponse
      )
        return yield* new InvalidMessage({
          reason: localized(m.chat_error_agent_fixed_at_start),
        });
      const agentId = input.questionResponse ? null : input.agentId;

      // One transaction: a lost attachment claim must not leave behind an
      // empty conversation or a user message nobody will answer.
      const turnFields: TurnFields = {
        userId: input.userId,
        conversation: input.conversation,
        ...(input.reservationId !== undefined ? { reservationId: input.reservationId } : {}),
        modelId: input.modelId,
        attachmentIds: input.attachmentIds,
        ...(input.collectionIds !== undefined ? { collectionIds: input.collectionIds } : {}),
        ...(input.skillIds !== undefined ? { skillIds: input.skillIds } : {}),
        ...(input.origin ? { origin: input.origin } : {}),
        associateAgentId: agentId ?? undefined,
        saveIntegrationChoices: input.integrationChoices?.length
          ? (tx, conversationId) =>
              integrations.setConversationChoices(
                tx,
                input.userId,
                conversationId,
                input.integrationChoices!,
              )
          : undefined,
        resolve: resolver({
          ...(input.questionResponse
            ? { attempt: "answer", reasoningEffort: input.reasoningEffort }
            : {
                attempt: "send",
                searchEnabled: input.searchEnabled,
                researchEnabled,
                reasoningEffort: input.reasoningEffort,
              }),
          userId: input.userId,
          imageModelId: input.imageModelId,
          desktop: input.desktop,
          workspaceFiles,
          model,
          searchAvailable,
          collectionIds: input.collectionIds,
          skillIds: input.skillIds,
        }),
      };
      const turn = yield* repo.createTurn(
        input.questionResponse !== undefined
          ? { ...turnFields, questionResponse: input.questionResponse }
          : { ...turnFields, content: input.content },
      );

      return yield* startTurn({
        userId: input.userId,
        modelId: input.modelId,
        turn,
        attachmentFileNames,
        workspaceFileNames: workspaceFiles,
        timeZone: input.timeZone,
        openDocument: input.openDocument,
        desktop: input.desktop,
        deviceSessionId: input.deviceSessionId,
      });
    });

    // The tail every accepted turn shares: publish, start the generation, and
    // set a title on a brand-new conversation. sendMessage reaches it through
    // the composer; runScheduledTurn reaches it with none of that. A reserved
    // Work turn has not activated yet, so nothing here fires for it.
    const startTurn = Effect.fn("ChatService.startTurn")(function* (input: {
      userId: string;
      modelId: string;
      turn: Effect.Success<ReturnType<typeof repo.createTurn>>;
      attachmentFileNames: ReadonlyArray<string>;
      workspaceFileNames?: ReadonlyArray<string> | undefined;
      timeZone?: string | undefined;
      openDocument?: OpenDocument | undefined;
      desktop?: DesktopSubmission | undefined;
      deviceSessionId?: string | undefined;
      onSettled?: Effect.Effect<void> | undefined;
    }) {
      const { turn } = input;
      if (turn.activatedNow && turn.conversationCreated) {
        yield* sync.publish(input.userId, {
          type: "conversation.created",
          conversationId: turn.conversation.id,
        });
      }

      if (turn.activatedNow)
        yield* announceStarted(input.userId, turn.conversation.id, turn.assistant.id);

      if (turn.activatedNow)
        yield* startAttempt({
          desktop: input.desktop,
          deviceSessionId: input.deviceSessionId,
          userId: input.userId,
          conversationId: turn.conversation.id,
          messageId: turn.assistant.id,
          generationId: turn.assistant.generationId,
          modelId: input.modelId,
          timeZone: input.timeZone,
          openDocument: input.openDocument,
          onSettled: input.onSettled,
        });

      // Only a brand-new conversation has a pending title. Forked after the
      // answer so the reply never waits on it, and detached so it survives the
      // response ending.
      if (turn.activatedNow && turn.conversationCreated) {
        yield* Effect.forkDetach(
          generateConversationTitle(titleDeps, {
            userId: input.userId,
            conversationId: turn.conversation.id,
            modelId: input.modelId,
            content: turn.userMessage.content,
            attachmentFileNames: input.attachmentFileNames,
            workspaceFileNames: input.workspaceFileNames ?? [],
          }),
        );
      }

      return {
        conversationId: turn.conversation.id,
        assistantMessageId: turn.assistant.id,
        generationId: turn.assistant.generationId ?? null,
      };
    });

    const runScheduledTurn = Effect.fn("ChatService.runScheduledTurn")(function* (input: {
      userId: string;
      scheduleId: string;
      scheduleRunId: string;
      prompt: string;
      modelId: string | null;
      agentId: string | null;
      /** The schedule's image model; it moves the lock of a chat the schedule keeps using. */
      imageModelId?: string | null;
      searchEnabled: boolean;
      researchEnabled: boolean;
      collectionIds: ReadonlyArray<string>;
      skillIds: ReadonlyArray<string>;
      /** Consent given when the schedule was saved; the fire asks nobody. */
      integrationGrants: ReadonlyArray<IntegrationGrant>;
      timeZone: string;
      /**
       * A fresh chat, tagged with the schedule and its agent; or an existing
       * chat, which keeps its own agent (one cannot change after creation).
       */
      target: { kind: "new" } | { kind: "existing"; conversationId: string };
      onSettled: Effect.Effect<void>;
    }) {
      if (input.prompt.trim() === "")
        return yield* new InvalidMessage({ reason: localized(m.chat_error_message_empty) });
      // A saved model that vanished is not a reason to skip the fire: fall back
      // to the user's default chat model, the same one the composer preselects.
      const modelId = yield* resolveScheduleModel(input.userId, input.modelId);
      if (!modelId)
        return yield* new ModelNotFound({ modelId: input.modelId ?? "schedule default" });
      const { model, attachmentFileNames, researchEnabled } = yield* validateGenerationOptions({
        userId: input.userId,
        modelId,
        searchEnabled: input.searchEnabled,
        attachmentIds: [],
        researchEnabled: input.researchEnabled,
      });
      const searchAvailable = yield* searchToolEnabled;
      const target = input.target;
      // Saving a schedule already refuses a work chat; this keeps the fire
      // itself safe. Its tools run in the desktop app, which an unattended
      // turn never has, so it would start with nothing to run them.
      if (
        target.kind === "existing" &&
        (yield* repo.getConversationDefaults(target.conversationId)).mode === "work"
      )
        return yield* new InvalidMessage({ reason: localized(m.chat_error_work_chat_no_schedule) });
      const fire = (agentId: string | undefined) =>
        repo.createTurn({
          userId: input.userId,
          conversation:
            target.kind === "existing"
              ? { kind: "existing", id: target.conversationId }
              : { kind: "new", id: uuidv7(), mode: "chat" },
          modelId,
          content: input.prompt,
          attachmentIds: [],
          ...(agentId !== undefined ? { associateAgentId: agentId } : {}),
          ...(target.kind === "new" ? { scheduleId: input.scheduleId } : {}),
          scheduleRunId: input.scheduleRunId,
          resolve: resolver({
            attempt: "scheduled",
            userId: input.userId,
            searchEnabled: input.searchEnabled,
            researchEnabled,
            reasoningEffort: null,
            model,
            searchAvailable,
            imageModelId: input.imageModelId ?? null,
            collectionIds: input.collectionIds,
            skillIds: input.skillIds,
            // An empty grant list offers this unattended turn no integration at all.
            integrationGrants: input.integrationGrants,
          }),
        });
      const turn = yield* fire(
        target.kind === "new" ? (input.agentId ?? undefined) : undefined,
      ).pipe(
        // Only deletion may degrade an unattended job to plain chat. A retained
        // agent made inaccessible by policy must not run under changed settings.
        Effect.catchTag("AgentNotAvailable", (error) =>
          Effect.gen(function* () {
            const [existing] = error.agentId
              ? yield* db
                  .select({ id: savedAgents.id })
                  .from(savedAgents)
                  .where(eq(savedAgents.id, error.agentId))
                  .pipe(Effect.orDie)
              : [];
            if (existing) return yield* error;
            return yield* fire(undefined);
          }),
        ),
      );
      return yield* startTurn({
        userId: input.userId,
        modelId,
        turn,
        attachmentFileNames,
        timeZone: input.timeZone,
        onSettled: input.onSettled,
      });
    });

    const resolveScheduleModel = Effect.fn("ChatService.resolveScheduleModel")(function* (
      userId: string,
      saved: string | null,
    ) {
      if (saved && (yield* providers.usableModel(userId, saved, "chat"))) return saved;
      const models = yield* providers.listChatModelsFor(userId);
      return (models.find((model) => model.isDefault) ?? models[0])?.id ?? null;
    });

    const restartAssistant = Effect.fn("ChatService.restartAssistant")(function* (input: {
      desktop?: DesktopSubmission | undefined;
      expectedMessages: HistorySnapshot;
      deviceSessionId?: string | undefined;
      userId: string;
      conversationId: string;
      assistantMessageId: string;
      modelId: string;
      imageModelId?: string | null | undefined;
      timeZone?: string | undefined;
      openDocument?: OpenDocument | undefined;
      deleteMessageIds: ReadonlyArray<string>;
      invalidateCheckpointThroughMessageIds: ReadonlyArray<string>;
      edit?: EditChoices & {
        messageId: string;
        attachmentIds: ReadonlyArray<string>;
        reasoningEffort?: ReasoningEffort | null | undefined;
      };
    }) {
      const model = yield* providers.getModel(input.modelId);
      if (!model) return yield* new ModelNotFound({ modelId: input.modelId });
      const searchAvailable = yield* searchToolEnabled;
      const { claimed, orphanedKeys, generationId } = yield* repo.resetMessageForRetry({
        expectedMessages: input.expectedMessages,
        userId: input.userId,
        messageId: input.assistantMessageId,
        modelId: input.modelId,
        deleteMessageIds: input.deleteMessageIds,
        invalidateCheckpointThroughMessageIds: input.invalidateCheckpointThroughMessageIds,
        resolve: resolver({
          userId: input.userId,
          model,
          searchAvailable,
          imageModelId: input.imageModelId,
          desktop: input.desktop,
          ...(!input.edit
            ? { attempt: "retry" }
            : input.edit.questionResponse
              ? { attempt: "answer", reasoningEffort: input.edit.reasoningEffort }
              : {
                  attempt: "edit",
                  searchEnabled: input.edit.searchEnabled,
                  researchEnabled: input.edit.researchEnabled,
                  reasoningEffort: input.edit.reasoningEffort,
                  ...(input.edit.skillIds ? { skillIds: input.edit.skillIds } : {}),
                  ...(input.edit.collectionIds ? { collectionIds: input.edit.collectionIds } : {}),
                }),
        }),
        ...(input.edit
          ? {
              edit: {
                ...input.edit,
                conversationId: input.conversationId,
              },
            }
          : {}),
      });
      // Only after the commit: a rollback must never orphan live rows' bytes.
      yield* attachmentService.deleteBlobs(orphanedKeys);
      if (!claimed || generationId === undefined) return null;

      yield* sync.publish(input.userId, {
        type: "message.status",
        conversationId: input.conversationId,
        messageId: input.assistantMessageId,
        status: "streaming",
      });

      yield* startAttempt({
        desktop: input.desktop,
        deviceSessionId: input.deviceSessionId,
        userId: input.userId,
        conversationId: input.conversationId,
        messageId: input.assistantMessageId,
        generationId,
        modelId: input.modelId,
        timeZone: input.timeZone,
        openDocument: input.openDocument,
      });

      return { assistantMessageId: input.assistantMessageId, generationId };
    });

    // Reuses the message row so ids stay stable for subscribers and the
    // sidebar; chunks/tool calls are wiped, later messages deleted, and the
    // stream starts over.
    const retryMessage = Effect.fn("ChatService.retryMessage")(function* (input: {
      desktop?: DesktopSubmission | undefined;
      userId: string;
      conversationId: string;
      messageId: string;
      modelId?: string | undefined;
      imageModelId?: string | null | undefined;
      deviceSessionId?: string | undefined;
      timeZone?: string | undefined;
      openDocument?: OpenDocument | undefined;
    }) {
      yield* repo.research?.reap() ?? Effect.void;
      // ownership check
      yield* repo.getConversation(input.userId, input.conversationId);

      const message = yield* repo.getMessage(input.messageId);
      if (!message || message.conversationId !== input.conversationId) {
        return yield* new MessageNotFound({ messageId: input.messageId });
      }
      if (message.role !== "assistant") {
        return yield* new RetryNotAllowed({
          messageId: input.messageId,
          reason: localized(m.chat_error_retry_only_answers),
        });
      }
      if (message.status === "streaming") {
        return yield* new RetryNotAllowed({
          messageId: input.messageId,
          reason: localized(m.chat_error_message_still_generating),
        });
      }
      // Retrying rewinds the conversation to this response: everything after
      // it is deleted (a later turn answering a response that no longer
      // exists would be nonsense). Refuse while any later message still
      // streams, since its generation fiber would keep writing to deleted rows.
      const all = yield* repo.listMessages(input.conversationId);
      const index = all.findIndex((row) => row.id === input.messageId);
      const after = all.slice(index + 1);
      if (after.some((row) => row.status === "streaming")) {
        return yield* new RetryNotAllowed({
          messageId: input.messageId,
          reason: localized(m.chat_error_later_message_generating),
        });
      }

      // An explicit choice also rescues a message whose model row has since
      // been deleted; picking another one is the only way to retry it at all.
      const switching = input.modelId !== undefined && input.modelId !== message.modelId;
      const modelId = input.modelId ?? message.modelId;
      if (!modelId) {
        return yield* new RetryNotAllowed({
          messageId: input.messageId,
          reason: localized(m.chat_error_original_model_unknown),
        });
      }
      // Checked on the resolved id: "Retry same" must also stop working once
      // the user's group access to the original model is gone.
      const model = yield* providers.usableModel(input.userId, modelId, "chat");
      if (!model) return yield* new ModelNotFound({ modelId });

      // A different model must read the question being answered again, which
      // is about its own files; earlier turns' files reach it as stand-ins.
      // Checked before anything is wiped, so a refusal leaves the answer as it
      // was. A plain retry faces what it already handled.
      if (switching) {
        const priorAttachments = yield* attachmentRepo.listForMessages(
          turnQuestionIds(all.slice(0, index)),
        );
        yield* validateAttachments(
          input.userId,
          model.capabilities,
          priorAttachments.map((a) => a.id),
        );
      }

      const restarted = yield* restartAssistant({
        desktop: input.desktop,
        deviceSessionId: input.deviceSessionId,
        expectedMessages: all,
        userId: input.userId,
        conversationId: input.conversationId,
        assistantMessageId: message.id,
        modelId,
        imageModelId: input.imageModelId,
        timeZone: input.timeZone,
        openDocument: input.openDocument,
        deleteMessageIds: after.map((row) => row.id),
        // From the retried answer onward: a summary that ends at this message
        // describes the response about to be thrown away. Rows after it are
        // deleted and cascade, but this one keeps its id.
        invalidateCheckpointThroughMessageIds: all.slice(index).map((row) => row.id),
      });
      if (!restarted) {
        return yield* new RetryNotAllowed({
          messageId: input.messageId,
          reason: localized(m.chat_error_message_already_generating),
        });
      }
      return restarted;
    });

    // Resume is retry without the rewind: the same checks and attempt-time
    // resolution, but the answer keeps everything it produced and the new
    // generation continues from it.
    const resumeMessage = Effect.fn("ChatService.resumeMessage")(function* (input: {
      desktop?: DesktopSubmission | undefined;
      userId: string;
      conversationId: string;
      messageId: string;
      modelId?: string | undefined;
      deviceSessionId?: string | undefined;
      timeZone?: string | undefined;
      openDocument?: OpenDocument | undefined;
    }) {
      yield* repo.research?.reap() ?? Effect.void;
      // ownership check
      yield* repo.getConversation(input.userId, input.conversationId);

      const message = yield* repo.getMessage(input.messageId);
      if (!message || message.conversationId !== input.conversationId) {
        return yield* new MessageNotFound({ messageId: input.messageId });
      }
      if (
        message.role !== "assistant" ||
        (message.status !== "error" && message.status !== "aborted")
      ) {
        return yield* new ResumeNotAllowed({
          messageId: input.messageId,
          reason: localized(m.chat_error_resume_only_failed),
        });
      }
      const switching = input.modelId !== undefined && input.modelId !== message.modelId;
      const modelId = input.modelId ?? message.modelId;
      if (!modelId) {
        return yield* new ResumeNotAllowed({
          messageId: input.messageId,
          reason: localized(m.chat_error_original_model_unknown),
        });
      }
      const model = yield* providers.usableModel(input.userId, modelId, "chat");
      if (!model) return yield* new ModelNotFound({ modelId });
      // Refused here, before the claim, so a resume that cannot succeed never
      // replaces the answer's error.
      const all = yield* repo.listMessages(input.conversationId);
      const nextTurn = resumeFirstTurn({
        calls: yield* repo.listToolCalls([message.id]),
        compactions: yield* repo.listCompactionEvents([message.id]),
        steerTurns: all
          .filter((row) => row.steeredIntoMessageId === message.id && row.status === "complete")
          .map((row) => row.steerTurnIndex ?? -1),
        files: message.assistantOutput?.files ?? [],
        replay: message.providerReplay,
      });
      if (nextTurn >= RESEARCH_TURN_BASE) {
        return yield* new ResumeNotAllowed({
          messageId: input.messageId,
          reason: localized(m.chat_error_resume_limit),
        });
      }
      // The answer goes on from its question and the steers it took in, so
      // a different model must read their files; earlier turns' are stand-ins.
      if (switching) {
        const priorAttachments = yield* attachmentRepo.listForMessages([
          ...turnQuestionIds(
            all.slice(
              0,
              all.findIndex((row) => row.id === message.id),
            ),
          ),
          ...all.filter((row) => row.steeredIntoMessageId === message.id).map((row) => row.id),
        ]);
        yield* validateAttachments(
          input.userId,
          model.capabilities,
          priorAttachments.map((a) => a.id),
        );
      }

      const claim = yield* repo.resumeMessage({
        userId: input.userId,
        messageId: message.id,
        modelId,
        resolve: resolver({
          userId: input.userId,
          model,
          searchAvailable: yield* searchToolEnabled,
          attempt: "resume",
          desktop: input.desktop,
        }),
      });
      if (!claim.claimed) {
        return yield* new ResumeNotAllowed({
          messageId: input.messageId,
          reason: localized(m.chat_error_resume_only_last),
        });
      }

      yield* sync.publish(input.userId, {
        type: "message.status",
        conversationId: input.conversationId,
        messageId: message.id,
        status: "streaming",
      });
      yield* startAttempt({
        desktop: input.desktop,
        deviceSessionId: input.deviceSessionId,
        userId: input.userId,
        conversationId: input.conversationId,
        messageId: message.id,
        generationId: claim.generationId,
        modelId,
        timeZone: input.timeZone,
        openDocument: input.openDocument,
        resume: true,
      });
      return { assistantMessageId: message.id };
    });

    const branchConversation = Effect.fn("ChatService.branchConversation")(function* (input: {
      userId: string;
      conversationId: string;
      messageId: string;
    }) {
      yield* repo.research?.reap() ?? Effect.void;
      // ownership check
      yield* repo.getConversation(input.userId, input.conversationId);

      const message = yield* repo.getMessage(input.messageId);
      if (!message || message.conversationId !== input.conversationId) {
        return yield* new MessageNotFound({ messageId: input.messageId });
      }
      if (message.role !== "assistant") {
        return yield* new BranchNotAllowed({
          messageId: input.messageId,
          reason: localized(m.chat_error_branch_only_answers),
        });
      }
      if (message.status === "streaming") {
        return yield* new BranchNotAllowed({
          messageId: input.messageId,
          reason: localized(m.chat_error_message_still_generating),
        });
      }

      const all = yield* repo.listMessages(input.conversationId);
      const index = all.findIndex((row) => row.id === input.messageId);
      const prefix = index === -1 ? [] : all.slice(0, index + 1);

      // Everything above is a fast pre-check for a decent error; the clone
      // re-validates under its own locks, which is what actually holds.
      const branch = yield* repo.cloneConversationPrefix({
        userId: input.userId,
        sourceConversationId: input.conversationId,
        throughMessageId: input.messageId,
      });

      yield* sync.publish(input.userId, {
        type: "conversation.created",
        conversationId: branch.id,
      });

      // Branching a chat whose title has not resolved yet would otherwise
      // leave the copy stuck on the placeholder forever. The source's own
      // title fiber only ever writes to the source.
      if (branch.title === null) {
        const seed = prefix.find((row) => row.role === "user");
        const firstAssistant = prefix.find((row) => row.role === "assistant");
        const attachmentFileNames = seed
          ? (yield* attachmentRepo.listForMessages([seed.id])).map((a) => a.fileName)
          : [];
        const titleInput = { content: seed?.content ?? "", attachmentFileNames };
        // The model of the first turn, like sendMessage, not the
        // conversation's current one.
        if (firstAssistant?.modelId) {
          yield* Effect.forkDetach(
            generateConversationTitle(titleDeps, {
              userId: input.userId,
              conversationId: branch.id,
              modelId: firstAssistant.modelId,
              ...titleInput,
            }),
          );
        } else if (
          yield* repo.setTitleIfPending(
            branch.id,
            fallbackTitle(titleInput, yield* language.localeOf(input.userId)),
          )
        ) {
          // That model row is gone (deleted provider), so there is nothing to
          // ask. Settle on the fallback rather than stay pending.
          yield* sync.publish(input.userId, {
            type: "conversation.updated",
            conversationId: branch.id,
          });
        }
      }

      return { conversationId: branch.id };
    });

    const editMessage = Effect.fn("ChatService.editMessage")(function* (
      input: EditChoices & {
        userId: string;
        conversationId: string;
        messageId: string;
        modelId: string;
        reasoningEffort?: ReasoningEffort | null | undefined;
        /** What the desktop app reports about the machine this edit came from. */
        desktop?: DesktopSubmission | undefined;
        deviceSessionId?: string | undefined;
        timeZone?: string | undefined;
        openDocument?: OpenDocument | undefined;
        attachmentIds: ReadonlyArray<string>;
        /** The composer's image model; absent keeps the chat's own. */
        imageModelId?: string | null | undefined;
      },
    ) {
      yield* repo.getConversation(input.userId, input.conversationId);
      const message = yield* repo.getMessage(input.messageId);
      if (!message || message.conversationId !== input.conversationId) {
        return yield* new MessageNotFound({ messageId: input.messageId });
      }
      if (message.role !== "user" || message.status !== "complete") {
        return yield* new EditNotAllowed({
          messageId: input.messageId,
          reason: localized(m.chat_error_edit_only_completed),
        });
      }
      // A steer is part of the answer it went into; editing it would restart
      // that answer from a message it never started with.
      if (message.steeredIntoMessageId) {
        return yield* new EditNotAllowed({
          messageId: input.messageId,
          reason: localized(m.chat_error_edit_steered),
        });
      }

      const all = yield* repo.listMessages(input.conversationId);
      const index = all.findIndex((candidate) => candidate.id === input.messageId);
      const after = all.slice(index + 1);
      if (after.some((candidate) => candidate.status === "streaming")) {
        return yield* new EditNotAllowed({
          messageId: input.messageId,
          reason: localized(m.chat_error_later_message_generating),
        });
      }

      const assistant = after.find((candidate) => candidate.role === "assistant");
      if (
        !input.questionResponse &&
        input.content.trim() === "" &&
        input.attachmentIds.length === 0
      ) {
        return yield* new InvalidMessage({ reason: localized(m.chat_error_message_empty) });
      }
      const { researchEnabled } = yield* validateGenerationOptions(input);
      // A question and its answer are created together, so an edit always has
      // an answer to regenerate.
      if (!assistant)
        return yield* new EditNotAllowed({
          messageId: input.messageId,
          reason: localized(m.chat_error_edit_no_answer),
        });
      // Preserve original standalone inputs, but resolve the current agent
      // and current document versions atomically before rewinding.

      const assistantIndex = all.findIndex((candidate) => candidate.id === assistant.id);
      const restarted = yield* restartAssistant({
        desktop: input.desktop,
        deviceSessionId: input.deviceSessionId,
        expectedMessages: all,
        userId: input.userId,
        conversationId: input.conversationId,
        assistantMessageId: assistant.id,
        modelId: input.modelId,
        imageModelId: input.imageModelId,
        timeZone: input.timeZone,
        openDocument: input.openDocument,
        deleteMessageIds: all.slice(assistantIndex + 1).map((candidate) => candidate.id),
        // From the edited user message onward, its text changes while the
        // row survives, so any summary covering it is stale.
        invalidateCheckpointThroughMessageIds: all.slice(index).map((candidate) => candidate.id),
        edit: {
          messageId: message.id,
          attachmentIds: input.attachmentIds,
          reasoningEffort: input.reasoningEffort,
          ...(input.questionResponse
            ? { questionResponse: input.questionResponse }
            : {
                content: input.content,
                searchEnabled: input.searchEnabled,
                researchEnabled,
                ...(input.skillIds ? { skillIds: input.skillIds } : {}),
                ...(input.collectionIds ? { collectionIds: input.collectionIds } : {}),
              }),
        },
      });
      if (!restarted) {
        return yield* new EditNotAllowed({
          messageId: input.messageId,
          reason: localized(m.chat_error_response_already_generating),
        });
      }
      return restarted;
    });

    const sweepInterval = yield* QueueSweepInterval;
    if (sweepInterval) yield* queue.startQueueSweeper(sweepInterval);
    const conversationSweepInterval = yield* ConversationSweepInterval;
    if (conversationSweepInterval) yield* lifecycle.startSweeper(conversationSweepInterval);

    return ChatService.of({
      reserveWorkTurn,
      getWorkTurnReservation,
      abortWorkTurn,
      sendMessage,
      queueMessage: queue.queueMessage,
      replaceQueuedMessage: queue.replaceQueuedMessage,
      removeQueuedMessage: queue.removeQueuedMessage,
      steerQueuedMessage: queue.steerQueuedMessage,
      dispatchQueuedMessage: queue.dispatchQueuedMessage,
      sendQueuedNow: queue.sendQueuedNow,
      retryMessage,
      resumeMessage,
      branchConversation,
      editMessage,
      stopGeneration: lifecycle.stopGeneration,
      deleteConversation: lifecycle.deleteConversation,
      restoreConversation: lifecycle.restoreConversation,
      updateWorkSettings: lifecycle.updateWorkSettings,
      renameConversation: lifecycle.renameConversation,
      keepConversation: lifecycle.keepConversation,
      markRead: lifecycle.markRead,
      setArchived: lifecycle.setArchived,
      archiveAll: lifecycle.archiveAll,
      listArchived: lifecycle.listArchived,
      sweepExpired: lifecycle.sweepExpired,
      runScheduledTurn,
    });
  });
}
