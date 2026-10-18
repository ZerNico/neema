import { IntegrationRepo } from "~/modules/integrations/server/repo.ts";
import { requireEligibleAccount } from "~/modules/auth/server/account-eligibility.ts";
import type { DesktopSubmission, OpenDocument } from "../schema.ts";
import type { QueuedTurnInput } from "../queued-turn.ts";
import type { SkillNotAvailable, SkillRejected } from "~/modules/skills/errors.ts";
import { Context, Duration, Effect, Layer, Option, Schedule } from "effect";
import { sendsReasoningEffort } from "~/modules/providers/provider-presets.ts";
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
import { attachmentKind, MAX_ATTACHMENTS_PER_MESSAGE } from "~/modules/attachments/constants.ts";
import { AttachmentNotAvailable, AttachmentUnsupported } from "~/modules/attachments/errors.ts";
import { DocumentParser } from "~/modules/attachments/server/document-parser.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { AiGateway } from "~/modules/providers/server/gateway.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import type { ReasoningEffort } from "~/modules/providers/model-config.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { UrlReaderExecutor } from "~/modules/tools/server/url-reader.ts";
import { ToolUnavailable, WebSearchExecutor } from "~/modules/tools/server/web-search.ts";
import { AgentNotAvailable } from "~/modules/agents/errors.ts";
import { resolveProject } from "~/modules/projects/server/access.ts";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import { resolveImageModel } from "~/modules/images/server/resolve.ts";
import { KnowledgeRepo } from "~/modules/knowledge/server/repo.ts";
import { KnowledgeNotAvailable, KnowledgeRejected } from "~/modules/knowledge/errors.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { Db } from "~/server/db.ts";
import { agents as savedAgents } from "~/db/schema/index.ts";
import { eq } from "drizzle-orm";
import {
  resolveAgentSelection,
  resolveEffectiveGeneration,
  resolveAttemptSkills,
} from "./effective-config.ts";
import {
  ChatRepo,
  type ConversationDefaults,
  type EditContent,
  type HistorySnapshot,
  type ResolveGeneration,
  type TurnContent,
  type TurnFields,
  type ResolveError,
  type WorkTurnReservationRow,
} from "./repo.ts";
import { StreamEngine } from "./streaming.ts";
import { resumeFirstTurn } from "./prompt.ts";
import { RESEARCH_TURN_BASE } from "./research/execution.ts";
import { ConversationSweepInterval, QueueSweepInterval } from "./generation-fence.ts";
import { fallbackTitle, generateConversationTitle, type TitleDeps } from "./title.ts";
import type { IntegrationGrant } from "~/modules/integrations/grant.ts";

/**
 * One folder the sending machine named, by its real path. The path is the
 * model's address for everything inside; it flows through attempt-scoped
 * prompt text and tool traffic only, and is never written to a row.
 */
export type DesktopFolderRef = DesktopSubmission["desktopFolders"] extends
  | ReadonlyArray<infer F>
  | undefined
  ? F
  : never;

// Omit on the whole input would flatten the content/question-response union;
// keep the discriminant intact by omitting from the plain fields only.
type SendTurnInput = Omit<TurnFields, "associateAgentId" | "resolve" | "saveIntegrationChoices"> &
  TurnContent & {
    /** Integration toggles made in the composer before this chat existed. */
    integrationChoices?: ReadonlyArray<{ integrationId: string; enabled: boolean }> | undefined;
    searchEnabled: boolean;
    researchEnabled: boolean;
    reasoningEffort?: ReasoningEffort | null | undefined;
    /** Folders attached on the machine this send came from. */
    desktopFolders?: ReadonlyArray<DesktopFolderRef> | undefined;
    desktopCommands?: boolean | undefined;
    desktopBrowser?: boolean | undefined;
    fromDesktop?: boolean | undefined;
    desktopExecutorId?: string | undefined;
    desktopMachineId?: string | undefined;
    desktopMachineName?: string | undefined;
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

/** A text-and-files submission held for later, with the settings it was made under. */
type QueueSubmission = {
  userId: string;
  conversationId: string;
  content: string;
  attachmentIds: ReadonlyArray<string>;
  input: QueuedTurnInput;
  /** Present when queued from the desktop app; a Work chat requires it. */
  desktop?: DesktopDispatch | undefined;
};

type QueueSubmissionError =
  | ModelNotFound
  | ToolUnavailable
  | InvalidMessage
  | WorkDesktopRequired
  | AttachmentUnsupported
  | AttachmentNotAvailable;

/**
 * What the desktop app reports when it queues or starts Work: which folders it
 * has attached, whether it can sandbox, and which running app it is. The
 * device session comes from the authenticated request, never the body.
 */
export type DesktopDispatch = {
  fromDesktop: boolean;
  desktopFolders?: ReadonlyArray<DesktopFolderRef> | undefined;
  desktopCommands?: boolean | undefined;
  desktopBrowser?: boolean | undefined;
  desktopExecutorId: string;
  /** Which machine runs it, so the chat names where its files are. */
  desktopMachineId?: string | undefined;
  desktopMachineName?: string | undefined;
  deviceSessionId?: string | undefined;
};

/** What the page learns of a Work turn reservation. */
const reservationView = (row: WorkTurnReservationRow) => ({
  reservationId: row.id,
  conversationId: row.conversationId,
  status: row.status,
  assistantMessageId: row.assistantMessageId,
});
type WorkTurnReservationView = ReturnType<typeof reservationView>;

/** What the queue strip says when a queued message could not start. */
const queueFailure = (error: { readonly _tag: string }) => {
  switch (error._tag) {
    case "AttachmentUnsupported":
    case "AttachmentNotAvailable":
      return "A file in this message can’t be read by its model anymore. Edit it or remove it.";
    case "AccountIneligible":
      return "This account can’t start messages. Try Send now after access is restored.";
    case "ModelNotFound":
      return "This message’s model is no longer available. Edit it to pick another.";
    default:
      return "This message could not be started. Its model or collections may no longer be available.";
  }
};

/** Orchestrates the chat use-cases on top of repo + stream engine + sync bus. */
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
     * fresh fields of the app dispatching it. Without them it waits, since the
     * server cannot name a live machine on its own.
     */
    dispatchQueuedMessage(input: {
      userId: string;
      conversationId: string;
      force?: boolean | undefined;
      /** Start this entry rather than the head; see `sendQueuedNow`. */
      entryId?: string | undefined;
      desktop?: DesktopDispatch | undefined;
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
      desktop?: DesktopDispatch | undefined;
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
    retryMessage(
      input: DesktopSubmission & {
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
      },
    ): Effect.Effect<
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
    resumeMessage(
      input: DesktopSubmission & {
        userId: string;
        conversationId: string;
        messageId: string;
        /** Continue with this model instead of the one that answered before. */
        modelId?: string | undefined;
        deviceSessionId?: string | undefined;
        timeZone?: string | undefined;
        openDocument?: OpenDocument | undefined;
      },
    ): Effect.Effect<
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
      input: EditContent & {
        userId: string;
        conversationId: string;
        messageId: string;
        modelId: string;
        searchEnabled: boolean;
        researchEnabled: boolean;
        reasoningEffort?: ReasoningEffort | null | undefined;
        desktopFolders?: ReadonlyArray<DesktopFolderRef> | undefined;
        desktopCommands?: boolean | undefined;
        desktopBrowser?: boolean | undefined;
        fromDesktop?: boolean | undefined;
        desktopExecutorId?: string | undefined;
        desktopMachineId?: string | undefined;
        desktopMachineName?: string | undefined;
        deviceSessionId?: string | undefined;
        timeZone?: string | undefined;
        openDocument?: OpenDocument | undefined;
        attachmentIds: ReadonlyArray<string>;
        /** Omitted keeps the attempt's saved selection; sent replaces it. */
        skillIds?: ReadonlyArray<string> | undefined;
        collectionIds?: ReadonlyArray<string> | undefined;
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
      scheduleRunId?: string;
      prompt: string;
      modelId: string | null;
      agentId: string | null;
      imageModelId?: string | null;
      searchEnabled: boolean;
      researchEnabled: boolean;
      collectionIds: ReadonlyArray<string>;
      skillIds: ReadonlyArray<string>;
      integrationGrants?: ReadonlyArray<IntegrationGrant>;
      timeZone: string;
      target: { kind: "new" } | { kind: "existing"; conversationId: string };
      /** Runs once the fire's answer has ended, however it ended. */
      onSettled?: Effect.Effect<void>;
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
    const engine = yield* StreamEngine;
    const sync = yield* SyncBus;
    const webSearch = yield* WebSearchExecutor;
    const urlReaderOption = yield* Effect.serviceOption(UrlReaderExecutor);
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

    // Recovers queues a restart or a reaped generation left waiting: the
    // in-process completion hook is gone with the fiber that owned it, and the
    // promotion transaction refuses anything the hook would have refused. Work
    // chats are not swept; only a desktop app can start them.
    const startQueueSweeper = (
      drain: (userId: string, conversationId: string) => Effect.Effect<void>,
      interval: Duration.Duration,
    ) =>
      Effect.forkScoped(
        Effect.gen(function* () {
          const pending = yield* repo.listQueuedConversations({ limit: 20, mode: "chat" });
          yield* Effect.forEach(pending, (row) => drain(row.userId, row.conversationId), {
            discard: true,
          });
        }).pipe(
          Effect.catchCause((cause) => Effect.logError("queue sweep failed", cause)),
          Effect.delay(interval),
          Effect.forever,
        ),
      );

    // The composer's toggle gates web_search only; read_url is gated by user URLs.
    const searchToolEnabled = Effect.gen(function* () {
      const search = yield* webSearch.availability();
      return search.configured && search.enabled;
    });
    const attachmentRepo = yield* AttachmentRepo;
    const attachmentService = yield* AttachmentService;
    const agents = yield* AgentRepo;
    const knowledge = yield* KnowledgeRepo;
    const integrations = yield* IntegrationRepo;
    const documentParser = yield* DocumentParser;
    const gateway = yield* AiGateway;
    const analytics = yield* AnalyticsRepo;
    const titleDeps: TitleDeps = { gateway, repo, sync, providers, analytics };

    const supportsReasoningEffort = Effect.fn("ChatService.supportsReasoningEffort")(function* (
      model: {
        providerId: string;
        modelKey: string;
        capabilities: { reasoningEfforts?: ReadonlyArray<ReasoningEffort> };
      },
      effort: ReasoningEffort,
    ) {
      if (!model.capabilities.reasoningEfforts?.includes(effort)) return false;
      const provider = (yield* providers.listProviders()).find(
        (row) => row.id === model.providerId,
      );
      return !!provider && sendsReasoningEffort(provider, model.modelKey);
    });

    const validateGenerationOptions = Effect.fn("ChatService.validateGenerationOptions")(
      function* (input: {
        userId: string;
        modelId: string;
        searchEnabled: boolean;
        attachmentIds: ReadonlyArray<string>;
        researchEnabled?: boolean | undefined;
        reasoningEffort?: ReasoningEffort | null | undefined;
      }) {
        if (input.attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE) {
          return yield* new InvalidMessage({
            reason: `at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`,
          });
        }

        const model = yield* providers.getModel(input.modelId);
        if (!model || !model.enabled || model.type !== "chat") {
          return yield* new ModelNotFound({ modelId: input.modelId });
        }
        // Group-restricted models answer exactly like nonexistent ones, so a
        // denied id discloses nothing.
        if (!(yield* providers.isModelAccessible(input.userId, input.modelId))) {
          return yield* new ModelNotFound({ modelId: input.modelId });
        }
        if (
          input.reasoningEffort != null &&
          !(yield* supportsReasoningEffort(model, input.reasoningEffort))
        )
          return yield* new InvalidMessage({
            reason: "This model does not support the selected reasoning effort.",
          });

        if (input.searchEnabled && !(yield* policy.can(input.userId, "webSearch")))
          return yield* new ToolUnavailable({ tool: "web_search", reason: "not permitted" });
        if (input.researchEnabled && !(yield* policy.can(input.userId, "deepResearch")))
          return yield* new ToolUnavailable({ tool: "deep_research", reason: "not permitted" });
        if (input.researchEnabled && !(yield* policy.can(input.userId, "webSearch")))
          return yield* new ToolUnavailable({
            tool: "deep_research",
            reason: "web search is not permitted",
          });
        if (input.attachmentIds.length && !(yield* policy.can(input.userId, "attachments")))
          return yield* new AttachmentNotAvailable({ attachmentId: input.attachmentIds[0]! });

        // The research toggle only offers the tool, so an instance without
        // search or a reader degrades to not offering it. Refusing the whole
        // message would make an unrelated admin setting reject ordinary chat.
        const reader =
          input.researchEnabled && Option.isSome(urlReaderOption)
            ? yield* urlReaderOption.value.availability()
            : null;
        const researchEnabled =
          !!input.researchEnabled &&
          !!reader?.configured &&
          reader.enabled &&
          (yield* searchToolEnabled);
        if (input.searchEnabled && !(yield* searchToolEnabled)) {
          return yield* new ToolUnavailable({ tool: "web_search", reason: "not enabled" });
        }

        const attachmentFileNames = yield* validateAttachments(
          input.userId,
          model.capabilities,
          input.attachmentIds,
        );

        return { model, attachmentFileNames, researchEnabled };
      },
    );

    // Rejects attachments the model cannot read before anything is written, so
    // the user gets a 400 instead of a generation that fails halfway through.
    // Returns their file names in the caller's order, since the title generator
    // needs them and the rows are already loaded here.
    const validateAttachments = Effect.fn("ChatService.validateAttachments")(function* (
      userId: string,
      capabilities: { vision: boolean; files: boolean },
      attachmentIds: ReadonlyArray<string>,
    ) {
      if (attachmentIds.length === 0) return [] as ReadonlyArray<string>;

      const rows = yield* attachmentRepo.listWithBlobsByIds(userId, attachmentIds);
      const byId = new Map(rows.map((row) => [row.id, row]));
      // Parsing availability is only consulted once, and only if a PDF meets a
      // model that cannot read files natively.
      let parsing: { configured: boolean; enabled: boolean } | null = null;
      const fileNames: string[] = [];

      for (const attachmentId of attachmentIds) {
        const row = byId.get(attachmentId);
        if (!row) return yield* new AttachmentNotAvailable({ attachmentId });

        fileNames.push(row.fileName);

        const kind = attachmentKind(row.mediaType);
        if (kind === "image" && !capabilities.vision) {
          return yield* new AttachmentUnsupported({
            fileName: row.fileName,
            reason: "this model cannot read images",
          });
        }
        if (kind === "pdf" && !capabilities.files) {
          parsing ??= yield* documentParser.availability();
          if (!parsing.configured || !parsing.enabled) {
            return yield* new AttachmentUnsupported({
              fileName: row.fileName,
              reason:
                "this model cannot read PDFs and document parsing is disabled. Enable it in admin settings or pick a model that accepts files",
            });
          }
        }
      }

      return fileNames;
    });

    // Sends a user message (creates the conversation on first message).
    // Returns ids the client needs to subscribe to the assistant stream.
    // Effective configuration resolves inside the turn's transaction against
    // conversation defaults, so what is stored is what was read; access
    // failures fail the turn before any row is written.
    const resolver =
      (
        input: {
          userId: string;
          model: {
            providerId: string;
            modelKey: string;
            contextLength: number | null | undefined;
            capabilities: { reasoningEfforts?: ReadonlyArray<ReasoningEffort> };
          };
          searchAvailable: boolean;
          collectionIds?: ReadonlyArray<string> | undefined;
          skillIds?: ReadonlyArray<string> | undefined;
          /** Folders the sending machine reported; retry has no submission. */
          desktopFolders?: ReadonlyArray<DesktopFolderRef> | undefined;
          desktopCommands?: boolean | undefined;
          desktopBrowser?: boolean | undefined;
          fromDesktop?: boolean | undefined;
          desktopExecutorId?: string | undefined;
          /** Which machine this attempt is sent from; a retry re-stamps it. */
          desktopMachineId?: string | undefined;
          desktopMachineName?: string | undefined;
          /** Files this send copied into the workspace; only a send carries them. */
          workspaceFiles?: ReadonlyArray<string> | undefined;
          /** A queued choice was valid when submitted, but policy may have changed. */
          allowStaleReasoningEffort?: boolean;
          /**
           * A schedule fire's up-front consent. Every other attempt, a retry of
           * a fired answer included, has a person present and passes none.
           */
          integrationGrants?: ReadonlyArray<IntegrationGrant>;
          /** The image model this submission picked; absent keeps the chat's own. */
          imageModelId?: string | null | undefined;
          /** Continues the same answer, so it keeps the image model it drew with. */
          resume?: boolean;
        } & (
          | {
              attempt: "retry";
              searchEnabled?: never;
              researchEnabled?: never;
              reasoningEffort?: never;
            }
          | {
              attempt: "send" | "edit";
              searchEnabled: boolean;
              researchEnabled: boolean;
              reasoningEffort?: ReasoningEffort | null | undefined;
            }
        ),
      ): ResolveGeneration =>
      (tx, defaults: ConversationDefaults, continuation) =>
        Effect.gen(function* () {
          yield* requireEligibleAccount(tx, input.userId);
          const imageModel = yield* resolveImageModel(tx, {
            userId: input.userId,
            conversationId: defaults.conversationId,
            lockId: defaults.imageModelId,
            explicitId: input.imageModelId,
            agentId: defaults.agent?.agentId,
            ...(input.resume ? { resumedId: continuation?.imageModel?.id ?? null } : {}),
          });
          // Read here like an agent, so retry and edit meet the project as it is
          // now, and a person who lost access cannot keep working in it.
          const resolvedProject = defaults.projectId
            ? yield* resolveProject(tx, input.userId, defaults.projectId).pipe(
                Effect.catchTag("ProjectNotAvailable", () =>
                  Effect.fail(
                    new InvalidMessage({
                      reason:
                        "This chat’s project is no longer available to you. Remove the chat from the project to continue.",
                    }),
                  ),
                ),
              )
            : null;
          const allowedSearch = yield* policy.can(input.userId, "webSearch", tx);
          const allowedResearch = yield* policy.can(input.userId, "deepResearch", tx);
          const searchEnabled =
            input.attempt === "retry"
              ? continuation
                ? continuation.searchEnabled && input.searchAvailable
                : yield* Effect.die("Retry requires a saved generation configuration")
              : input.attempt === "edit"
                ? input.searchEnabled && input.searchAvailable
                : (continuation?.searchEnabled ?? input.searchEnabled);
          // Same three cases as search. The third matters most here: the tool
          // cannot ask anything itself, so a clarification round would
          // otherwise answer into a turn that can no longer research.
          const researchEnabled =
            input.attempt === "retry"
              ? (continuation?.researchEnabled ?? false)
              : input.attempt === "edit"
                ? input.researchEnabled
                : (continuation?.researchEnabled ?? input.researchEnabled);
          const savedEffort = continuation?.reasoningEffort ?? null;
          const submittedEffort = input.attempt === "retry" ? undefined : input.reasoningEffort;
          const chosenEffort = submittedEffort !== undefined ? submittedEffort : savedEffort;
          const supportedEffort =
            chosenEffort === null || (yield* supportsReasoningEffort(input.model, chosenEffort));
          if (!supportedEffort && submittedEffort != null && !input.allowStaleReasoningEffort)
            return yield* new InvalidMessage({
              reason: "This model does not support the selected reasoning effort.",
            });
          const reasoningEffort = supportedEffort ? chosenEffort : null;
          if (searchEnabled && !allowedSearch)
            return yield* new InvalidMessage({ reason: "web search is not permitted" });
          if (researchEnabled && (!allowedResearch || !allowedSearch))
            return yield* new InvalidMessage({ reason: "deep research is not permitted" });
          if (defaults.mode === "work" && !(yield* policy.can(input.userId, "work", tx)))
            return yield* new InvalidMessage({ reason: "Work is not permitted" });
          if ((input.workspaceFiles?.length ?? 0) > 0 && defaults.mode !== "work")
            return yield* new InvalidMessage({ reason: "workspace files require Work" });
          const desktopFolderEntries =
            defaults.mode === "work" && input.desktopFolders && input.desktopFolders.length > 0
              ? input.desktopFolders
              : null;
          // What the sending app could do, kept for Work alone: these flags are
          // the one place the stream learns whether a machine tool is offered.
          const desktopCommands = defaults.mode === "work" && !!input.desktopCommands;
          const desktopBrowser = defaults.mode === "work" && !!input.desktopBrowser;
          if (defaults.mode === "work" && (!input.fromDesktop || !input.desktopExecutorId))
            return yield* new WorkDesktopRequired();
          // Re-stamped on every attempt, retry included: the banner must
          // name the machine the chat actually last worked on.
          const desktopMachineId =
            defaults.mode === "work" ? (input.desktopMachineId ?? null) : null;
          const desktopMachineName =
            defaults.mode === "work" ? (input.desktopMachineName ?? null) : null;
          // An edit that submits a selection is changing it, so it cannot take the
          // replay shortcut below: new collections need a rebuilt manifest.
          const editing = input.attempt === "edit";
          const editedCollections = editing ? input.collectionIds : undefined;
          const editedSkills = editing ? input.skillIds : undefined;
          if (!defaults.agent && continuation && editedCollections === undefined) {
            yield* knowledge.authorizeManifest(
              input.userId,
              continuation.collectionIds,
              continuation.manifest,
              tx,
            );
            return {
              ...continuation,
              // Plain knowledge retains its old manifest semantics; skills deliberately do not.
              skills: yield* resolveAttemptSkills(
                tx,
                input.userId,
                editedSkills ?? continuation.standaloneSkillIds ?? [],
                [],
              ),
              searchEnabled,
              researchEnabled,
              reasoningEffort,
              desktopFolders: desktopFolderEntries?.map((folder) => folder.name) ?? null,
              desktopCommands,
              desktopBrowser,
              desktopMachineId,
              desktopMachineName,
              // Only a fresh send adds files; retry and edit replay the list.
              workspaceFiles: input.workspaceFiles ?? continuation.workspaceFiles ?? [],
              integrationGrants: input.integrationGrants ?? null,
              resolvedProject,
              imageModel,
            };
          }
          const agent = defaults.agent
            ? defaults.agent.agentId
              ? yield* resolveAgentSelection({
                  tx,
                  userId: input.userId,
                  agentId: defaults.agent.agentId,
                })
              : yield* new AgentNotAvailable({ agentId: "deleted" })
            : null;
          const resolved = yield* resolveEffectiveGeneration({
            tx,
            userId: input.userId,
            agent,
            // Omitted still keeps the saved selection; only a submitted one wins.
            collectionIds: editing
              ? (editedCollections ?? continuation?.standaloneCollectionIds)
              : (continuation?.standaloneCollectionIds ?? input.collectionIds),
            skillIds: editing
              ? (editedSkills ?? continuation?.standaloneSkillIds)
              : (continuation?.standaloneSkillIds ?? input.skillIds),
            searchEnabled,
            researchEnabled,
            reasoningEffort,
            desktopFolders: desktopFolderEntries,
            desktopCommands,
            desktopBrowser,
            desktopMachineId,
            desktopMachineName,
            workspaceFiles: input.workspaceFiles ?? continuation?.workspaceFiles ?? [],
            model: input.model,
            searchAvailable: input.searchAvailable,
          });
          return {
            ...resolved,
            integrationGrants: input.integrationGrants ?? null,
            resolvedProject,
            imageModel,
          };
        }).pipe(
          Effect.provideService(KnowledgeRepo, knowledge),
          Effect.provideService(AgentRepo, agents),
          Effect.provideService(ProviderRepo, providers),
        );

    const reserveWorkTurn = Effect.fn("ChatService.reserveWorkTurn")(function* (input: {
      id: string;
      userId: string;
      conversation: TurnFields["conversation"];
    }) {
      if (!(yield* policy.can(input.userId, "work")))
        return yield* new InvalidMessage({ reason: "Work is not permitted" });
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

    /**
     * Everything a send would check, run now while the person is still looking
     * at the composer. Dispatch checks again, since a model or a collection can
     * go away while the message waits.
     */
    const validateQueueSubmission = Effect.fn("ChatService.validateQueueSubmission")(function* (
      input: QueueSubmission,
    ) {
      if (input.content.trim() === "" && input.attachmentIds.length === 0)
        return yield* new InvalidMessage({ reason: "message is empty" });
      const conversation = yield* repo.getConversation(input.userId, input.conversationId);
      if (conversation.mode === "work" && !(yield* policy.can(input.userId, "work")))
        return yield* new InvalidMessage({ reason: "Work is not permitted" });
      // Queued Work runs on a machine, so it can only be handed over from one.
      if (conversation.mode === "work" && !input.desktop?.fromDesktop)
        return yield* new WorkDesktopRequired();
      yield* validateGenerationOptions({
        userId: input.userId,
        modelId: input.input.modelId,
        searchEnabled: input.input.searchEnabled,
        researchEnabled: input.input.researchEnabled,
        reasoningEffort: input.input.reasoningEffort,
        attachmentIds: input.attachmentIds,
      });
    });

    const queueChanged = (userId: string, conversationId: string) =>
      sync.publish(userId, { type: "conversation.queue.changed", conversationId });

    const queueMessage = Effect.fn("ChatService.queueMessage")(function* (input: QueueSubmission) {
      yield* validateQueueSubmission(input);
      const entry = yield* repo.enqueue({
        userId: input.userId,
        conversationId: input.conversationId,
        content: input.content.trim(),
        attachmentIds: input.attachmentIds,
        input: input.input,
      });
      yield* queueChanged(input.userId, input.conversationId);
      // The answer it was queued behind may have finished while this request
      // was in flight; waiting for the sweep would stall it for no reason.
      yield* drainQueue(input.userId, input.conversationId);
      return { entryId: entry.id };
    });

    const replaceQueuedMessage = Effect.fn("ChatService.replaceQueuedMessage")(function* (
      input: QueueSubmission & { entryId: string },
    ) {
      yield* validateQueueSubmission(input);
      const orphaned = yield* repo.replaceQueueEntry({
        userId: input.userId,
        conversationId: input.conversationId,
        entryId: input.entryId,
        content: input.content.trim(),
        attachmentIds: input.attachmentIds,
        input: input.input,
      });
      yield* attachmentService.deleteBlobs(orphaned);
      yield* queueChanged(input.userId, input.conversationId);
      // Editing is how a person fixes an entry that could not start; with its
      // error cleared it may start now rather than at the next sweep.
      yield* drainQueue(input.userId, input.conversationId);
    });

    const removeQueuedMessage = Effect.fn("ChatService.removeQueuedMessage")(function* (input: {
      userId: string;
      conversationId: string;
      entryId: string;
    }) {
      const orphaned = yield* repo.removeQueueEntry(input);
      yield* attachmentService.deleteBlobs(orphaned);
      yield* queueChanged(input.userId, input.conversationId);
    });

    const steerQueuedMessage = Effect.fn("ChatService.steerQueuedMessage")(function* (input: {
      userId: string;
      conversationId: string;
      entryId: string;
      messageId: string;
      generationId: string;
    }) {
      yield* repo.getConversation(input.userId, input.conversationId);
      // A steer joins an answer already running on its own model, which may
      // not be the one the entry was queued with. Its files have to be
      // readable by that model, or the continuation would fail mid-answer.
      const running = yield* repo.getMessage(input.messageId);
      const entry = (yield* repo.listQueue(input.conversationId)).find(
        (item) => item.id === input.entryId,
      );
      if (!entry) return yield* new QueueEntryNotFound({ entryId: input.entryId });
      const model = running?.modelId ? yield* providers.getModel(running.modelId) : null;
      if (model && entry.attachments.length > 0)
        yield* validateAttachments(
          input.userId,
          model.capabilities,
          entry.attachments.map((file) => file.id),
        ).pipe(
          Effect.catchTag("AttachmentNotAvailable", () =>
            Effect.fail(new QueueEntryNotFound({ entryId: input.entryId })),
          ),
        );
      yield* repo.steerQueueEntry({ ...input, expectedRevision: entry.revision });
      yield* queueChanged(input.userId, input.conversationId);
    });

    const startNextQueued = Effect.fn("ChatService.startNextQueued")(function* (input: {
      userId: string;
      conversationId: string;
      force?: boolean | undefined;
      entryId?: string | undefined;
      desktop?: DesktopDispatch | undefined;
    }): Effect.fn.Return<
      { started: boolean },
      | ConversationNotFound
      | ModelNotFound
      | ToolUnavailable
      | AttachmentNotAvailable
      | AttachmentUnsupported
      | ResolveError
    > {
      const conversation = yield* repo.getConversation(input.userId, input.conversationId);
      // Not an error: the entry simply waits for a desktop app to pick it up.
      if (conversation.mode === "work" && !input.desktop) return { started: false };
      const queue = yield* repo.listQueue(input.conversationId);
      const head = input.entryId ? queue.find((entry) => entry.id === input.entryId) : queue[0];
      if (!head || (head.lastError && !(input.force && input.entryId))) return { started: false };
      return yield* Effect.gen(function* () {
        const { model, researchEnabled } = yield* validateGenerationOptions({
          userId: input.userId,
          modelId: head.input.modelId,
          searchEnabled: head.input.searchEnabled,
          researchEnabled: head.input.researchEnabled,
          attachmentIds: head.attachments.map((file) => file.id),
        });
        const searchAvailable = yield* searchToolEnabled;
        const outcome = yield* repo.promoteNextQueuedTurn({
          userId: input.userId,
          conversationId: input.conversationId,
          expectedEntryId: head.id,
          expectedRevision: head.revision,
          ...(input.entryId ? { jumpQueue: true } : {}),
          ...(input.force ? { force: true } : {}),
          resolve: (entry) =>
            resolver({
              attempt: "send",
              userId: input.userId,
              model,
              searchAvailable,
              imageModelId: entry.input.imageModelId,
              searchEnabled: entry.input.searchEnabled,
              researchEnabled,
              reasoningEffort: entry.input.reasoningEffort,
              allowStaleReasoningEffort: true,
              collectionIds: entry.input.collectionIds,
              skillIds: entry.input.skillIds,
              // Taken from the dispatching app now, never from queue time.
              desktopFolders: input.desktop?.desktopFolders,
              desktopCommands: input.desktop?.desktopCommands,
              desktopBrowser: input.desktop?.desktopBrowser,
              fromDesktop: input.desktop?.fromDesktop,
              desktopExecutorId: input.desktop?.desktopExecutorId,
              desktopMachineId: input.desktop?.desktopMachineId,
              desktopMachineName: input.desktop?.desktopMachineName,
            }),
        });
        // A replacement or reordered head needs fresh validation on the next dispatch.
        if (!outcome.promoted) return { started: false };
        yield* announceStarted(input.userId, input.conversationId, outcome.assistant.id);
        yield* queueChanged(input.userId, input.conversationId);
        yield* engine.startGeneration({
          userId: input.userId,
          conversationId: input.conversationId,
          messageId: outcome.assistant.id,
          generationId: outcome.assistant.generationId ?? undefined,
          modelId: outcome.entry.input.modelId,
          searchEnabled: outcome.config.searchEnabled,
          timeZone: outcome.entry.input.timeZone,
          openDocument: outcome.entry.input.openDocument,
          desktopExecutorId: input.desktop?.desktopExecutorId,
          ...(input.desktop?.desktopFolders !== undefined
            ? { desktopFolders: input.desktop.desktopFolders }
            : {}),
          deviceSessionId: input.desktop?.deviceSessionId,
          onSettled: ({ status }) =>
            status === "complete" ? drainQueue(input.userId, input.conversationId) : Effect.void,
        });
        return { started: true };
      }).pipe(
        Effect.tapError((error) =>
          Effect.gen(function* () {
            yield* repo.setQueueEntryError(head.id, head.revision, queueFailure(error));
            yield* queueChanged(input.userId, input.conversationId);
          }),
        ),
      );
    });

    /**
     * Every path that starts a queued message goes through here, so a head
     * whose model, files or collections went away is annotated whoever tried:
     * the server's own drain, a desktop app, or a person pressing the button.
     * The entry is kept, never dropped.
     */
    const dispatchQueuedMessage = (input: Parameters<typeof startNextQueued>[0]) =>
      startNextQueued(input);

    const sendQueuedNow = Effect.fn("ChatService.sendQueuedNow")(function* (input: {
      userId: string;
      conversationId: string;
      entryId: string;
      desktop?: DesktopDispatch | undefined;
    }) {
      const conversation = yield* repo.getConversation(input.userId, input.conversationId);
      // Only a desktop app can start Work. Without one, stopping the answer
      // would leave nothing running and the message still waiting.
      if (conversation.mode === "work" && !input.desktop) return { started: false };
      const live = (yield* repo.listMessages(input.conversationId)).find(
        (message) => message.status === "streaming",
      );
      if (live) {
        const generationId = live.generationId ?? undefined;
        yield* stopGeneration({
          userId: input.userId,
          conversationId: input.conversationId,
          messageId: live.id,
          generationId,
        });
        // Finalize is quick, but the promotion must see the stopped row. A
        // stall leaves the entry queued for Send next rather than hanging.
        yield* engine
          .awaitSettled(live.id, generationId)
          .pipe(Effect.timeout(Duration.seconds(10)), Effect.ignore);
      }
      // A person asked for this one, so it may start after the stop.
      return yield* dispatchQueuedMessage({ ...input, force: true });
    });

    /** Dispatch that never fails its caller; the reason is already on the entry. */
    const drainQueue = (userId: string, conversationId: string): Effect.Effect<void> =>
      Effect.suspend(() => dispatchQueuedMessage({ userId, conversationId })).pipe(
        Effect.asVoid,
        Effect.catch((error) =>
          Effect.logError("queued message dispatch failed", { conversationId, error }),
        ),
      );

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
        return yield* new InvalidMessage({ reason: "message is empty" });
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
        return yield* new InvalidMessage({ reason: "a work chat cannot be temporary" });
      if (
        input.conversation.kind === "new" &&
        input.conversation.temporary &&
        input.conversation.projectId
      )
        return yield* new InvalidMessage({ reason: "a temporary chat cannot join a project" });

      // The association is fixed at creation; its configuration is live for
      // every subsequent attempt. Swapping or removal is not a chat setting.
      if (
        input.agentId !== undefined &&
        input.conversation.kind === "existing" &&
        !input.questionResponse
      )
        return yield* new InvalidMessage({
          reason: "the agent is chosen when a chat starts and cannot change afterwards",
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
          attempt: "send",
          userId: input.userId,
          imageModelId: input.imageModelId,
          searchEnabled: input.searchEnabled,
          researchEnabled,
          reasoningEffort: input.reasoningEffort,
          ...(input.desktopFolders !== undefined ? { desktopFolders: input.desktopFolders } : {}),
          ...(input.desktopCommands !== undefined
            ? { desktopCommands: input.desktopCommands }
            : {}),
          ...(input.desktopBrowser !== undefined ? { desktopBrowser: input.desktopBrowser } : {}),
          ...(input.fromDesktop !== undefined ? { fromDesktop: input.fromDesktop } : {}),
          desktopExecutorId: input.desktopExecutorId,
          desktopMachineId: input.desktopMachineId,
          desktopMachineName: input.desktopMachineName,
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
        desktopExecutorId: input.desktopExecutorId,
        ...(input.desktopFolders !== undefined ? { desktopFolders: input.desktopFolders } : {}),
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
      desktopExecutorId?: string | undefined;
      desktopFolders?: ReadonlyArray<DesktopFolderRef> | undefined;
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
        yield* engine.startGeneration({
          desktopExecutorId: input.desktopExecutorId,
          ...(input.desktopFolders !== undefined ? { desktopFolders: input.desktopFolders } : {}),
          deviceSessionId: input.deviceSessionId,
          userId: input.userId,
          conversationId: turn.conversation.id,
          messageId: turn.assistant.id,
          generationId: turn.assistant.generationId ?? undefined,
          modelId: input.modelId,
          searchEnabled: turn.config.searchEnabled,
          timeZone: input.timeZone,
          openDocument: input.openDocument,
          // Queued messages start only after an answer ends cleanly, so a stop
          // or a failure leaves the rest of the queue for the person to decide on.
          onSettled: ({ status }) =>
            (input.onSettled ?? Effect.void).pipe(
              Effect.andThen(
                status === "complete"
                  ? drainQueue(input.userId, turn.conversation.id)
                  : Effect.void,
              ),
            ),
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
      scheduleRunId?: string;
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
      integrationGrants?: ReadonlyArray<IntegrationGrant>;
      timeZone: string;
      /**
       * A fresh chat, tagged with the schedule and its agent; or an existing
       * chat, which keeps its own agent (one cannot change after creation).
       */
      target: { kind: "new" } | { kind: "existing"; conversationId: string };
      onSettled?: Effect.Effect<void>;
    }) {
      if (input.prompt.trim() === "")
        return yield* new InvalidMessage({ reason: "message is empty" });
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
        return yield* new InvalidMessage({ reason: "a work chat cannot run a schedule" });
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
          ...(input.scheduleRunId ? { scheduleRunId: input.scheduleRunId } : {}),
          resolve: resolver({
            attempt: "send",
            userId: input.userId,
            searchEnabled: input.searchEnabled,
            researchEnabled,
            reasoningEffort: null,
            model,
            searchAvailable,
            imageModelId: input.imageModelId ?? null,
            collectionIds: input.collectionIds,
            skillIds: input.skillIds,
            // Always set on a fire, empty included: an empty grant list means
            // this unattended turn is offered no integration at all.
            integrationGrants: input.integrationGrants ?? [],
          }),
        });
      const turn = yield* fire(
        target.kind === "new" ? (input.agentId ?? undefined) : undefined,
      ).pipe(
        // Only deletion may degrade an unattended job to plain chat. A retained
        // agent made inaccessible by policy must not run under changed settings.
        Effect.catchTag("AgentNotAvailable", (error) =>
          Effect.gen(function* () {
            const [existing] = yield* db
              .select({ id: savedAgents.id })
              .from(savedAgents)
              .where(eq(savedAgents.id, error.agentId))
              .pipe(Effect.orDie);
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
      if (saved) {
        const model = yield* providers.getModel(saved);
        if (
          model &&
          model.enabled &&
          model.type === "chat" &&
          (yield* providers.isModelAccessible(userId, saved))
        )
          return saved;
      }
      const models = yield* providers.listChatModelsFor(userId);
      return (models.find((model) => model.isDefault) ?? models[0])?.id ?? null;
    });

    const restartAssistant = Effect.fn("ChatService.restartAssistant")(function* (
      input: DesktopSubmission & {
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
        edit?: EditContent & {
          messageId: string;
          attachmentIds: ReadonlyArray<string>;
          searchEnabled: boolean;
          researchEnabled: boolean;
          reasoningEffort?: ReasoningEffort | null | undefined;
          desktopFolders?: ReadonlyArray<DesktopFolderRef> | undefined;
          desktopCommands?: boolean | undefined;
          desktopBrowser?: boolean | undefined;
          fromDesktop?: boolean | undefined;
          desktopExecutorId?: string | undefined;
          desktopMachineId?: string | undefined;
          desktopMachineName?: string | undefined;
          skillIds?: ReadonlyArray<string> | undefined;
          collectionIds?: ReadonlyArray<string> | undefined;
        };
      },
    ) {
      const model = yield* providers.getModel(input.modelId);
      if (!model) return yield* new ModelNotFound({ modelId: input.modelId });
      const searchAvailable = yield* searchToolEnabled;
      const { claimed, orphanedKeys, generationId, searchEnabled } =
        yield* repo.resetMessageForRetry({
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
            ...(input.edit
              ? {
                  attempt: "edit",
                  searchEnabled: input.edit.searchEnabled,
                  researchEnabled: input.edit.researchEnabled,
                  reasoningEffort: input.edit.reasoningEffort,
                  desktopExecutorId: input.desktopExecutorId,
                  desktopMachineId: input.edit.desktopMachineId,
                  desktopMachineName: input.edit.desktopMachineName,
                  ...(input.edit.desktopFolders !== undefined
                    ? { desktopFolders: input.edit.desktopFolders }
                    : {}),
                  ...(input.edit.desktopCommands !== undefined
                    ? { desktopCommands: input.edit.desktopCommands }
                    : {}),
                  ...(input.edit.desktopBrowser !== undefined
                    ? { desktopBrowser: input.edit.desktopBrowser }
                    : {}),
                  ...(input.edit.fromDesktop !== undefined
                    ? { fromDesktop: input.edit.fromDesktop }
                    : {}),
                  ...(input.edit.skillIds ? { skillIds: input.edit.skillIds } : {}),
                  ...(input.edit.collectionIds ? { collectionIds: input.edit.collectionIds } : {}),
                }
              : {
                  attempt: "retry",
                  fromDesktop: input.fromDesktop,
                  desktopExecutorId: input.desktopExecutorId,
                  desktopFolders: input.desktopFolders,
                  desktopCommands: input.desktopCommands,
                  desktopBrowser: input.desktopBrowser,
                  desktopMachineId: input.desktopMachineId,
                  desktopMachineName: input.desktopMachineName,
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

      yield* engine.startGeneration({
        desktopExecutorId: input.desktopExecutorId,
        ...(input.desktopFolders !== undefined ? { desktopFolders: input.desktopFolders } : {}),
        deviceSessionId: input.deviceSessionId,
        userId: input.userId,
        conversationId: input.conversationId,
        messageId: input.assistantMessageId,
        generationId,
        modelId: input.modelId,
        searchEnabled: searchEnabled!,
        timeZone: input.timeZone,
        openDocument: input.openDocument,
        onSettled: ({ status }) =>
          status === "complete" ? drainQueue(input.userId, input.conversationId) : Effect.void,
      });

      return { assistantMessageId: input.assistantMessageId, generationId };
    });

    // Reuses the message row so ids stay stable for subscribers and the
    // sidebar; chunks/tool calls are wiped, later messages deleted, and the
    // stream starts over.
    const retryMessage = Effect.fn("ChatService.retryMessage")(function* (
      input: DesktopSubmission & {
        userId: string;
        conversationId: string;
        messageId: string;
        modelId?: string | undefined;
        imageModelId?: string | null | undefined;
        deviceSessionId?: string | undefined;
        timeZone?: string | undefined;
        openDocument?: OpenDocument | undefined;
      },
    ) {
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
          reason: "only assistant messages can be retried",
        });
      }
      if (message.status === "streaming") {
        return yield* new RetryNotAllowed({
          messageId: input.messageId,
          reason: "message is still generating",
        });
      }
      // Retrying rewinds the conversation to this response: everything after
      // it is deleted (a later turn answering a response that no longer
      // exists would be nonsense). Refuse while any later message still
      // streams, since its generation fiber would keep writing to deleted rows.
      const all = yield* repo.listMessages(input.conversationId);
      const index = all.findIndex((m) => m.id === input.messageId);
      const after = all.slice(index + 1);
      if (after.some((m) => m.status === "streaming")) {
        return yield* new RetryNotAllowed({
          messageId: input.messageId,
          reason: "a later message is still generating",
        });
      }

      // An explicit choice also rescues a message whose model row has since
      // been deleted; picking another one is the only way to retry it at all.
      const switching = input.modelId !== undefined && input.modelId !== message.modelId;
      const modelId = input.modelId ?? message.modelId;
      if (!modelId) {
        return yield* new RetryNotAllowed({
          messageId: input.messageId,
          reason: "original model is no longer known",
        });
      }
      const model = yield* providers.getModel(modelId);
      if (!model || !model.enabled || model.type !== "chat") {
        return yield* new ModelNotFound({ modelId });
      }
      // Checked on the resolved id: "Retry same" must also stop working once
      // the user's group access to the original model is gone.
      if (!(yield* providers.isModelAccessible(input.userId, modelId))) {
        return yield* new ModelNotFound({ modelId });
      }

      // The history stays as it is, so a different model has to be able to
      // read the files already in it. Checked before anything is wiped: a
      // rejected switch leaves the existing answer untouched. Skipped for a
      // plain retry, which by definition faces what it already handled.
      if (switching) {
        const priorAttachments = yield* attachmentRepo.listForMessages(
          all
            .slice(0, index)
            .filter((m) => m.role === "user")
            .map((m) => m.id),
        );
        yield* validateAttachments(
          input.userId,
          model.capabilities,
          priorAttachments.map((a) => a.id),
        );
      }

      const restarted = yield* restartAssistant({
        desktopExecutorId: input.desktopExecutorId,
        deviceSessionId: input.deviceSessionId,
        fromDesktop: input.fromDesktop,
        desktopFolders: input.desktopFolders,
        desktopCommands: input.desktopCommands,
        desktopBrowser: input.desktopBrowser,
        expectedMessages: all,
        userId: input.userId,
        conversationId: input.conversationId,
        assistantMessageId: message.id,
        modelId,
        imageModelId: input.imageModelId,
        timeZone: input.timeZone,
        openDocument: input.openDocument,
        deleteMessageIds: after.map((m) => m.id),
        // From the retried answer onward: a summary that ends at this message
        // describes the response about to be thrown away. Rows after it are
        // deleted and cascade, but this one keeps its id.
        invalidateCheckpointThroughMessageIds: all.slice(index).map((m) => m.id),
      });
      if (!restarted) {
        return yield* new RetryNotAllowed({
          messageId: input.messageId,
          reason: "message is already generating",
        });
      }
      return restarted;
    });

    // Resume is retry without the rewind: the same checks and attempt-time
    // resolution, but the answer keeps everything it produced and the new
    // generation continues from it.
    const resumeMessage = Effect.fn("ChatService.resumeMessage")(function* (
      input: DesktopSubmission & {
        userId: string;
        conversationId: string;
        messageId: string;
        modelId?: string | undefined;
        deviceSessionId?: string | undefined;
        timeZone?: string | undefined;
        openDocument?: OpenDocument | undefined;
      },
    ) {
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
          reason: "only a failed or stopped answer can be resumed",
        });
      }
      const switching = input.modelId !== undefined && input.modelId !== message.modelId;
      const modelId = input.modelId ?? message.modelId;
      if (!modelId) {
        return yield* new ResumeNotAllowed({
          messageId: input.messageId,
          reason: "original model is no longer known",
        });
      }
      const model = yield* providers.getModel(modelId);
      if (!model || !model.enabled || model.type !== "chat") {
        return yield* new ModelNotFound({ modelId });
      }
      if (!(yield* providers.isModelAccessible(input.userId, modelId))) {
        return yield* new ModelNotFound({ modelId });
      }
      // Refused here, before the claim, so a resume that cannot succeed never
      // replaces the answer's error.
      const all = yield* repo.listMessages(input.conversationId);
      const nextTurn = resumeFirstTurn({
        calls: yield* repo.listToolCalls([message.id]),
        compactions: yield* repo.listCompactionEvents([message.id]),
        steerTurns: all
          .filter((m) => m.steeredIntoMessageId === message.id && m.status === "complete")
          .map((m) => m.steerTurnIndex ?? -1),
        files: message.assistantOutput?.files ?? [],
        replay: message.providerReplay,
      });
      if (nextTurn >= RESEARCH_TURN_BASE) {
        return yield* new ResumeNotAllowed({
          messageId: input.messageId,
          reason: "this answer has reached its continuation limit; start a new message instead",
        });
      }
      // The answer is the last turn, so every user message is history the
      // new model has to read, its steers included.
      if (switching) {
        const priorAttachments = yield* attachmentRepo.listForMessages(
          all.filter((m) => m.role === "user").map((m) => m.id),
        );
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
          attempt: "retry",
          resume: true,
          fromDesktop: input.fromDesktop,
          desktopExecutorId: input.desktopExecutorId,
          desktopFolders: input.desktopFolders,
          desktopCommands: input.desktopCommands,
          desktopBrowser: input.desktopBrowser,
          desktopMachineId: input.desktopMachineId,
          desktopMachineName: input.desktopMachineName,
        }),
      });
      if (!claim.claimed) {
        return yield* new ResumeNotAllowed({
          messageId: input.messageId,
          reason: "only the last answer can be resumed, and not while another is generating",
        });
      }

      yield* sync.publish(input.userId, {
        type: "message.status",
        conversationId: input.conversationId,
        messageId: message.id,
        status: "streaming",
      });
      yield* engine.startGeneration({
        desktopExecutorId: input.desktopExecutorId,
        ...(input.desktopFolders !== undefined ? { desktopFolders: input.desktopFolders } : {}),
        deviceSessionId: input.deviceSessionId,
        userId: input.userId,
        conversationId: input.conversationId,
        messageId: message.id,
        generationId: claim.generationId,
        modelId,
        searchEnabled: claim.searchEnabled,
        timeZone: input.timeZone,
        openDocument: input.openDocument,
        resume: true,
        onSettled: ({ status }) =>
          status === "complete" ? drainQueue(input.userId, input.conversationId) : Effect.void,
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
          reason: "only assistant messages can be branched from",
        });
      }
      if (message.status === "streaming") {
        return yield* new BranchNotAllowed({
          messageId: input.messageId,
          reason: "message is still generating",
        });
      }

      const all = yield* repo.listMessages(input.conversationId);
      const index = all.findIndex((m) => m.id === input.messageId);
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
        const seed = prefix.find((m) => m.role === "user");
        const firstAssistant = prefix.find((m) => m.role === "assistant");
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
        } else if (yield* repo.setTitleIfPending(branch.id, fallbackTitle(titleInput))) {
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
      input: EditContent & {
        userId: string;
        conversationId: string;
        messageId: string;
        modelId: string;
        searchEnabled: boolean;
        researchEnabled: boolean;
        reasoningEffort?: ReasoningEffort | null | undefined;
        /** Folders attached on the machine this edit came from. */
        desktopFolders?: ReadonlyArray<DesktopFolderRef> | undefined;
        desktopCommands?: boolean | undefined;
        desktopBrowser?: boolean | undefined;
        fromDesktop?: boolean | undefined;
        desktopExecutorId?: string | undefined;
        desktopMachineId?: string | undefined;
        desktopMachineName?: string | undefined;
        deviceSessionId?: string | undefined;
        timeZone?: string | undefined;
        openDocument?: OpenDocument | undefined;
        attachmentIds: ReadonlyArray<string>;
        /** Omitted keeps the attempt's saved selection; sent replaces it. */
        skillIds?: ReadonlyArray<string> | undefined;
        collectionIds?: ReadonlyArray<string> | undefined;
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
          reason: "only completed user messages can be edited",
        });
      }
      // A steer is part of the answer it went into; editing it would restart
      // that answer from a message it never started with.
      if (message.steeredIntoMessageId) {
        return yield* new EditNotAllowed({
          messageId: input.messageId,
          reason: "a message sent into a response cannot be edited",
        });
      }

      const all = yield* repo.listMessages(input.conversationId);
      const index = all.findIndex((candidate) => candidate.id === input.messageId);
      const after = all.slice(index + 1);
      if (after.some((candidate) => candidate.status === "streaming")) {
        return yield* new EditNotAllowed({
          messageId: input.messageId,
          reason: "a later message is still generating",
        });
      }

      const assistant = after.find((candidate) => candidate.role === "assistant");
      if (
        !input.questionResponse &&
        input.content.trim() === "" &&
        input.attachmentIds.length === 0
      ) {
        return yield* new InvalidMessage({ reason: "message is empty" });
      }
      const { model, researchEnabled } = yield* validateGenerationOptions(input);
      const searchAvailable = yield* searchToolEnabled;
      const edit: EditContent = input.questionResponse
        ? { questionResponse: input.questionResponse }
        : { content: input.content };

      if (assistant) {
        // Preserve original standalone inputs, but resolve the current agent
        // and current document versions atomically before rewinding.

        const assistantIndex = all.findIndex((candidate) => candidate.id === assistant.id);
        const restarted = yield* restartAssistant({
          desktopExecutorId: input.desktopExecutorId,
          deviceSessionId: input.deviceSessionId,
          fromDesktop: input.fromDesktop,
          desktopFolders: input.desktopFolders,
          desktopCommands: input.desktopCommands,
          desktopBrowser: input.desktopBrowser,
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
            ...edit,
            attachmentIds: input.attachmentIds,
            searchEnabled: input.searchEnabled,
            researchEnabled,
            reasoningEffort: input.reasoningEffort,
            fromDesktop: input.fromDesktop,
            desktopExecutorId: input.desktopExecutorId,
            desktopMachineId: input.desktopMachineId,
            desktopMachineName: input.desktopMachineName,
            desktopFolders: input.desktopFolders,
            desktopCommands: input.desktopCommands,
            desktopBrowser: input.desktopBrowser,
            ...(input.skillIds ? { skillIds: input.skillIds } : {}),
            ...(input.collectionIds ? { collectionIds: input.collectionIds } : {}),
          },
        });
        if (!restarted) {
          return yield* new EditNotAllowed({
            messageId: input.messageId,
            reason: "response is already generating",
          });
        }
        return restarted;
      }

      const created = yield* repo.createAssistantForEdit({
        expectedMessages: all,
        userId: input.userId,
        conversationId: input.conversationId,
        userMessageId: message.id,
        expectedEditedAt: message.editedAt,
        ...edit,
        attachmentIds: input.attachmentIds,
        modelId: input.modelId,
        deleteMessageIds: after.map((candidate) => candidate.id),
        invalidateCheckpointThroughMessageIds: all.slice(index).map((candidate) => candidate.id),
        resolve: resolver({
          attempt: "edit",
          userId: input.userId,
          imageModelId: input.imageModelId,
          searchEnabled: input.searchEnabled,
          researchEnabled,
          reasoningEffort: input.reasoningEffort,
          ...(input.desktopFolders !== undefined ? { desktopFolders: input.desktopFolders } : {}),
          ...(input.desktopCommands !== undefined
            ? { desktopCommands: input.desktopCommands }
            : {}),
          ...(input.desktopBrowser !== undefined ? { desktopBrowser: input.desktopBrowser } : {}),
          ...(input.fromDesktop !== undefined ? { fromDesktop: input.fromDesktop } : {}),
          desktopExecutorId: input.desktopExecutorId,
          desktopMachineId: input.desktopMachineId,
          desktopMachineName: input.desktopMachineName,
          model,
          searchAvailable,
          ...(input.skillIds ? { skillIds: input.skillIds } : {}),
          ...(input.collectionIds ? { collectionIds: input.collectionIds } : {}),
        }),
      });
      if (!created) {
        return yield* new EditNotAllowed({
          messageId: input.messageId,
          reason: "message changed while it was being edited",
        });
      }
      yield* attachmentService.deleteBlobs(created.orphanedKeys);
      yield* sync.publish(input.userId, {
        type: "message.created",
        conversationId: input.conversationId,
        messageId: created.message.id,
      });
      yield* engine.startGeneration({
        desktopExecutorId: input.desktopExecutorId,
        ...(input.desktopFolders !== undefined ? { desktopFolders: input.desktopFolders } : {}),
        deviceSessionId: input.deviceSessionId,
        userId: input.userId,
        conversationId: input.conversationId,
        messageId: created.message.id,
        generationId: created.message.generationId ?? undefined,
        modelId: input.modelId,
        searchEnabled: created.config.searchEnabled,
        timeZone: input.timeZone,
        openDocument: input.openDocument,
        onSettled: ({ status }) =>
          status === "complete" ? drainQueue(input.userId, input.conversationId) : Effect.void,
      });

      return { assistantMessageId: created.message.id };
    });

    const stopGeneration = Effect.fn("ChatService.stopGeneration")(function* (input: {
      generationId?: string | undefined;
      userId: string;
      conversationId: string;
      messageId: string;
    }) {
      yield* repo.research?.reap() ?? Effect.void;
      // ownership check
      yield* repo.getConversation(input.userId, input.conversationId);
      // A Stop on a generation nobody is running is the user telling us the
      // process died. If the lease has lapsed, settle it now instead of waiting
      // for the timer; if it is still live elsewhere, the fence protects it.
      yield* engine.reapOrphans;
      const message = yield* repo.getMessage(input.messageId);
      if (!message || message.conversationId !== input.conversationId) {
        return yield* new MessageNotFound({ messageId: input.messageId });
      }
      // Already finished (or generating on another instance). The client
      // learns the real state from the `done` event either way.
      if (message.status !== "streaming") return { stopped: false };
      if (message.generationId && input.generationId !== message.generationId)
        return { stopped: false };
      // Stop ends the attempt; any run it started is cancelled with it.
      const durable =
        message.generationId && repo.research
          ? yield* repo.research.cancelForGeneration(message.id, message.generationId)
          : false;
      const stopped =
        (yield* engine.stopGeneration(input.messageId, input.generationId)) || durable;
      return { stopped };
    });

    const deleteConversation = Effect.fn("ChatService.deleteConversation")(function* (input: {
      userId: string;
      conversationId: string;
    }) {
      // Marked first: every way an answer starts locks the chat as owned and
      // not deleted, so nothing new begins once this commits, and the list
      // below is complete. A repeated delete returns the same mark and stops
      // again, so a retry finishes what a failed one left.
      const mark = yield* repo.trashConversation(input.userId, input.conversationId);
      if (mark === null) return null;
      yield* sync.publish(input.userId, {
        type: "conversation.deleted",
        conversationId: input.conversationId,
      });
      // Stopped the way Stop stops one, then awaited, so the answer has settled
      // as stopped before the client offers an Undo that brings it back. One
      // not started yet stops as it starts (`StreamEngine.stopGeneration`). A
      // failure here still leaves the chat deleted, so its Undo stays offered.
      yield* repo.listLiveAnswers(input.conversationId).pipe(
        Effect.flatMap((live) =>
          Effect.forEach(
            live,
            (answer) =>
              Effect.gen(function* () {
                const runId = answer.generationId ?? undefined;
                if (answer.generationId && repo.research)
                  yield* repo.research.cancelForGeneration(answer.messageId, answer.generationId);
                yield* engine.stopGeneration(answer.messageId, runId);
                // Awaited even when another Stop got there first and is still settling.
                yield* engine
                  .awaitSettled(answer.messageId, runId)
                  .pipe(Effect.timeoutOption(Duration.seconds(10)));
              }),
            { discard: true },
          ),
        ),
        Effect.catchCause((cause) =>
          Effect.logError("stopping a deleted chat's answers failed", cause),
        ),
      );
      return mark;
    });

    const restoreConversation = Effect.fn("ChatService.restoreConversation")(function* (input: {
      userId: string;
      conversationId: string;
      mark: string;
    }) {
      const restored = yield* repo.restoreConversation(
        input.userId,
        input.conversationId,
        input.mark,
      );
      if (restored)
        yield* sync.publish(input.userId, {
          type: "conversation.updated",
          conversationId: input.conversationId,
        });
      return restored;
    });

    const updateWorkSettings = Effect.fn("ChatService.updateWorkSettings")(function* (input: {
      userId: string;
      conversationId: string;
      permissionLevel: "manual" | "auto" | "skip";
    }) {
      const conversation = yield* repo.getConversation(input.userId, input.conversationId);
      if (conversation.mode !== "work")
        return yield* new InvalidMessage({ reason: "only a work chat has work settings" });
      yield* repo.updateConversation(input.conversationId, {
        permissionLevel: input.permissionLevel,
      });
      yield* sync.publish(input.userId, {
        type: "conversation.updated",
        conversationId: input.conversationId,
      });
    });

    const renameConversation = Effect.fn("ChatService.renameConversation")(function* (input: {
      userId: string;
      conversationId: string;
      title: string;
    }) {
      yield* repo.research?.reap() ?? Effect.void;
      // ownership check
      yield* repo.getConversation(input.userId, input.conversationId);
      yield* repo.updateConversation(input.conversationId, { title: input.title });
      yield* sync.publish(input.userId, {
        type: "conversation.updated",
        conversationId: input.conversationId,
      });
    });

    const markRead = Effect.fn("ChatService.markRead")(function* (input: {
      userId: string;
      conversationId: string;
    }) {
      if (yield* repo.markRead(input.userId, input.conversationId))
        yield* sync.publish(input.userId, {
          type: "conversation.updated",
          conversationId: input.conversationId,
        });
    });

    const keepConversation = Effect.fn("ChatService.keepConversation")(function* (input: {
      userId: string;
      conversationId: string;
    }) {
      yield* repo.getConversation(input.userId, input.conversationId);
      if (yield* repo.keepConversation(input.userId, input.conversationId))
        yield* sync.publish(input.userId, {
          type: "conversation.updated",
          conversationId: input.conversationId,
        });
    });

    const setArchived = Effect.fn("ChatService.setArchived")(function* (input: {
      userId: string;
      conversationId: string;
      archived: boolean;
    }) {
      yield* repo.getConversation(input.userId, input.conversationId);
      if (yield* repo.setArchived(input.userId, input.conversationId, input.archived))
        yield* sync.publish(input.userId, {
          type: "conversation.updated",
          conversationId: input.conversationId,
        });
    });

    const archiveAll = Effect.fn("ChatService.archiveAll")(function* (input: { userId: string }) {
      const ids = yield* repo.archiveAll(input.userId);
      // One event is enough: every tab refreshes its chat lists and details by
      // key prefix, whichever chat an update names.
      if (ids.length > 0)
        yield* sync.publish(input.userId, {
          type: "conversation.updated",
          conversationId: ids[0]!,
        });
      return ids.length;
    });

    const listArchived = Effect.fn("ChatService.listArchived")(function* (input: {
      userId: string;
    }) {
      return yield* repo.listArchived(input.userId);
    });

    // Purges deleted chats past their grace period and expired temporary
    // ones, so research, attachments and every open tab settle one way.
    const sweepExpired = Effect.fn("ChatService.sweepExpired")(function* () {
      const expired = yield* repo.listExpired(100);
      for (const { id } of expired) {
        const purged = yield* repo.purgeExpired(id);
        if (!purged) continue;
        yield* attachmentService.deleteBlobs(purged.keys);
        yield* sync.publish(purged.userId, { type: "conversation.purged", conversationId: id });
      }
    });

    const sweepInterval = yield* QueueSweepInterval;
    if (sweepInterval) yield* startQueueSweeper(drainQueue, sweepInterval);
    const conversationSweepInterval = yield* ConversationSweepInterval;
    if (conversationSweepInterval)
      yield* sweepExpired().pipe(
        Effect.catchCause((cause) => Effect.logError("expired chat sweep failed", cause)),
        // Failed calls' full arguments are kept a week, then go the same way.
        Effect.andThen(
          repo
            .sweepFailedCallArguments()
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logError("failed call arguments sweep failed", cause),
              ),
            ),
        ),
        // A settled answer is read from its row, so its chunks only serve a
        // late reconnect, and an hour covers that.
        Effect.andThen(
          repo
            .sweepCompletedChunks()
            .pipe(Effect.catchCause((cause) => Effect.logError("chunk sweep failed", cause))),
        ),
        Effect.repeat(Schedule.spaced(conversationSweepInterval)),
        Effect.forkScoped,
      );

    return ChatService.of({
      reserveWorkTurn,
      getWorkTurnReservation,
      abortWorkTurn,
      sendMessage,
      queueMessage,
      replaceQueuedMessage,
      removeQueuedMessage,
      steerQueuedMessage,
      dispatchQueuedMessage,
      sendQueuedNow,
      retryMessage,
      resumeMessage,
      branchConversation,
      editMessage,
      stopGeneration,
      deleteConversation,
      restoreConversation,
      updateWorkSettings,
      renameConversation,
      keepConversation,
      markRead,
      setArchived,
      archiveAll,
      listArchived,
      sweepExpired,
      runScheduledTurn,
    });
  });
}
