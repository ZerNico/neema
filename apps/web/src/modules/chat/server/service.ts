import type { DesktopSubmission } from "../schema.ts";
import type { SkillNotAvailable, SkillRejected } from "~/modules/skills/errors.ts";
import { Context, Effect, Layer, Option } from "effect";
import {
  BranchNotAllowed,
  ConversationBusy,
  ConversationNotFound,
  EditNotAllowed,
  InvalidMessage,
  MessageNotFound,
  ModelNotFound,
  RetryNotAllowed,
  QuestionUnavailable,
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
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { UrlReaderExecutor } from "~/modules/tools/server/url-reader.ts";
import { ToolUnavailable, WebSearchExecutor } from "~/modules/tools/server/web-search.ts";
import { AgentNotAvailable } from "~/modules/agents/errors.ts";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import { KnowledgeRepo } from "~/modules/knowledge/server/repo.ts";
import { KnowledgeNotAvailable, KnowledgeRejected } from "~/modules/knowledge/errors.ts";
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
} from "./repo.ts";
import { StreamEngine } from "./streaming.ts";
import { fallbackTitle, generateConversationTitle, type TitleDeps } from "./title.ts";

// Omit on the whole input would flatten the content/question-response union;
// keep the discriminant intact by omitting from the plain fields only.
type SendTurnInput = Omit<TurnFields, "associateAgentId" | "resolve"> &
  TurnContent & {
    searchEnabled: boolean;
    researchEnabled: boolean;
    /** Folders attached on the machine this send came from, by name. */
    desktopFolders?: ReadonlyArray<string> | undefined;
    desktopCommands?: boolean | undefined;
    fromDesktop?: boolean | undefined;
    desktopExecutorId?: string | undefined;
    /** See `ExternalOwner.deviceSessionId`; read from the session, never the body. */
    deviceSessionId?: string | undefined;
    timeZone?: string | undefined;
    /** The document open in the panel; the model reads it first. */
    openDocumentId?: string | undefined;
    /** See chat/schema.ts `generationFields.agentId`. */
    agentId?: string | null | undefined;
  };

/** Orchestrates the chat use-cases on top of repo + stream engine + sync bus. */
export class ChatService extends Context.Service<
  ChatService,
  {
    sendMessage(
      input: SendTurnInput,
    ): Effect.Effect<
      { conversationId: string; assistantMessageId: string },
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
        deviceSessionId?: string | undefined;
        timeZone?: string | undefined;
        openDocumentId?: string | undefined;
      },
    ): Effect.Effect<
      { assistantMessageId: string },
      | ConversationNotFound
      | MessageNotFound
      | ModelNotFound
      | RetryNotAllowed
      | AgentNotAvailable
      | WorkDesktopRequired
      | KnowledgeRejected
      | InvalidMessage
      | AttachmentNotAvailable
      | AttachmentUnsupported
      | SkillNotAvailable
      | SkillRejected
      | KnowledgeNotAvailable
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
      ConversationNotFound | MessageNotFound | BranchNotAllowed
    >;
    editMessage(
      input: EditContent & {
        userId: string;
        conversationId: string;
        messageId: string;
        modelId: string;
        searchEnabled: boolean;
        researchEnabled: boolean;
        desktopFolders?: ReadonlyArray<string> | undefined;
        desktopCommands?: boolean | undefined;
        fromDesktop?: boolean | undefined;
        desktopExecutorId?: string | undefined;
        deviceSessionId?: string | undefined;
        timeZone?: string | undefined;
        openDocumentId?: string | undefined;
        attachmentIds: ReadonlyArray<string>;
        /** Omitted keeps the attempt's saved selection; sent replaces it. */
        skillIds?: ReadonlyArray<string> | undefined;
        collectionIds?: ReadonlyArray<string> | undefined;
      },
    ): Effect.Effect<
      { assistantMessageId: string },
      | ConversationNotFound
      | MessageNotFound
      | ModelNotFound
      | EditNotAllowed
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
    deleteConversation(input: { userId: string; conversationId: string }): Effect.Effect<void>;
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
  }
>()("chat/chat/ChatService") {
  static readonly layer = Layer.effect(ChatService, makeChatService());
}

function makeChatService() {
  return Effect.gen(function* () {
    const repo = yield* ChatRepo;
    const providers = yield* ProviderRepo;
    const engine = yield* StreamEngine;
    const sync = yield* SyncBus;
    const webSearch = yield* WebSearchExecutor;
    const urlReaderOption = yield* Effect.serviceOption(UrlReaderExecutor);

    // The composer's toggle gates web_search only; read_url is gated by user URLs.
    const searchToolEnabled = Effect.gen(function* () {
      const search = yield* webSearch.availability();
      return search.configured && search.enabled;
    });
    const attachmentRepo = yield* AttachmentRepo;
    const attachmentService = yield* AttachmentService;
    const agents = yield* AgentRepo;
    const knowledge = yield* KnowledgeRepo;
    const documentParser = yield* DocumentParser;
    const gateway = yield* AiGateway;
    const analytics = yield* AnalyticsRepo;
    const titleDeps: TitleDeps = { gateway, repo, sync, providers, analytics };

    const validateGenerationOptions = Effect.fn("ChatService.validateGenerationOptions")(
      function* (input: {
        userId: string;
        modelId: string;
        searchEnabled: boolean;
        attachmentIds: ReadonlyArray<string>;
        researchEnabled?: boolean | undefined;
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
          model: { contextLength: number | null | undefined };
          searchAvailable: boolean;
          collectionIds?: ReadonlyArray<string> | undefined;
          skillIds?: ReadonlyArray<string> | undefined;
          /** Folders the sending machine reported; retry has no submission. */
          desktopFolders?: ReadonlyArray<string> | undefined;
          desktopCommands?: boolean | undefined;
          fromDesktop?: boolean | undefined;
          desktopExecutorId?: string | undefined;
        } & (
          | { attempt: "retry"; searchEnabled?: never; researchEnabled?: never }
          | { attempt: "send" | "edit"; searchEnabled: boolean; researchEnabled: boolean }
        ),
      ): ResolveGeneration =>
      (tx, defaults: ConversationDefaults, continuation) =>
        Effect.gen(function* () {
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
          const desktopFolders =
            defaults.mode === "work" && input.desktopFolders && input.desktopFolders.length > 0
              ? input.desktopFolders
              : null;
          const desktopCommands =
            defaults.mode === "work" && desktopFolders !== null && !!input.desktopCommands;
          if (defaults.mode === "work" && (!input.fromDesktop || !input.desktopExecutorId))
            return yield* new WorkDesktopRequired();
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
              desktopFolders,
              desktopCommands,
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
          return yield* resolveEffectiveGeneration({
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
            desktopFolders,
            desktopCommands,
            model: input.model,
            searchAvailable: input.searchAvailable,
          });
        }).pipe(
          Effect.provideService(KnowledgeRepo, knowledge),
          Effect.provideService(AgentRepo, agents),
        );

    const sendMessage = Effect.fn("ChatService.sendMessage")(function* (input: SendTurnInput) {
      if (
        !input.questionResponse &&
        input.content.trim() === "" &&
        input.attachmentIds.length === 0
      ) {
        return yield* new InvalidMessage({ reason: "message is empty" });
      }
      // The server stays authoritative even when the composer hides the toggle.
      yield* repo.research?.reap() ?? Effect.void;
      if (input.questionResponse && input.conversationId)
        yield* repo.getConversation(input.userId, input.conversationId);
      const { model, attachmentFileNames, researchEnabled } = yield* validateGenerationOptions(input);
      const searchAvailable = yield* searchToolEnabled;

      // The association is fixed at creation; its configuration is live for
      // every subsequent attempt. Swapping or removal is not a chat setting.
      if (input.agentId !== undefined && input.conversationId && !input.questionResponse)
        return yield* new InvalidMessage({
          reason: "the agent is chosen when a chat starts and cannot change afterwards",
        });
      const agentId = input.questionResponse ? null : input.agentId;

      // One transaction: a lost attachment claim must not leave behind an
      // empty conversation or a user message nobody will answer.
      const turn = yield* repo.createTurn({
        ...input,
        associateAgentId: agentId ?? undefined,
        resolve: resolver({
          attempt: "send",
          userId: input.userId,
          searchEnabled: input.searchEnabled,
          researchEnabled,
          ...(input.desktopFolders !== undefined ? { desktopFolders: input.desktopFolders } : {}),
          ...(input.desktopCommands !== undefined
            ? { desktopCommands: input.desktopCommands }
            : {}),
          ...(input.fromDesktop !== undefined ? { fromDesktop: input.fromDesktop } : {}),
          desktopExecutorId: input.desktopExecutorId,
          model,
          searchAvailable,
          collectionIds: input.collectionIds,
          skillIds: input.skillIds,
        }),
      });

      if (turn.conversationCreated) {
        yield* sync.publish(input.userId, {
          type: "conversation.created",
          conversationId: turn.conversation.id,
        });
      }

      yield* sync.publish(input.userId, {
        type: "message.created",
        conversationId: turn.conversation.id,
        messageId: turn.assistant.id,
      });

      yield* engine.startGeneration({
        desktopExecutorId: input.desktopExecutorId,
        deviceSessionId: input.deviceSessionId,
        userId: input.userId,
        conversationId: turn.conversation.id,
        messageId: turn.assistant.id,
        generationId: turn.assistant.generationId ?? undefined,
        modelId: input.modelId,
        searchEnabled: turn.config.searchEnabled,
        timeZone: input.timeZone,
        openDocumentId: input.openDocumentId,
      });

      // Only a brand-new conversation has a pending title. Forked after the
      // answer so the reply never waits on it, and detached so it survives the
      // response ending.
      if (turn.conversationCreated) {
        yield* Effect.forkDetach(
          generateConversationTitle(titleDeps, {
            userId: input.userId,
            conversationId: turn.conversation.id,
            modelId: input.modelId,
            content: turn.userMessage.content,
            attachmentFileNames,
          }),
        );
      }

      return { conversationId: turn.conversation.id, assistantMessageId: turn.assistant.id };
    });

    const restartAssistant = Effect.fn("ChatService.restartAssistant")(function* (
      input: DesktopSubmission & {
        expectedMessages: HistorySnapshot;
        deviceSessionId?: string | undefined;
        userId: string;
        conversationId: string;
        assistantMessageId: string;
        modelId: string;
        timeZone?: string | undefined;
        openDocumentId?: string | undefined;
        deleteMessageIds: ReadonlyArray<string>;
        invalidateCheckpointThroughMessageIds: ReadonlyArray<string>;
        edit?: EditContent & {
          messageId: string;
          attachmentIds: ReadonlyArray<string>;
          searchEnabled: boolean;
          researchEnabled: boolean;
          desktopFolders?: ReadonlyArray<string> | undefined;
          desktopCommands?: boolean | undefined;
          fromDesktop?: boolean | undefined;
          desktopExecutorId?: string | undefined;
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
            ...(input.edit
              ? {
                  attempt: "edit",
                  searchEnabled: input.edit.searchEnabled,
                  researchEnabled: input.edit.researchEnabled,
                  desktopExecutorId: input.desktopExecutorId,
                  ...(input.edit.desktopFolders !== undefined
                    ? { desktopFolders: input.edit.desktopFolders }
                    : {}),
                  ...(input.edit.desktopCommands !== undefined
                    ? { desktopCommands: input.edit.desktopCommands }
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
      if (!claimed) return null;

      yield* sync.publish(input.userId, {
        type: "message.status",
        conversationId: input.conversationId,
        messageId: input.assistantMessageId,
        status: "streaming",
      });

      yield* engine.startGeneration({
        desktopExecutorId: input.desktopExecutorId,
        deviceSessionId: input.deviceSessionId,
        userId: input.userId,
        conversationId: input.conversationId,
        messageId: input.assistantMessageId,
        generationId,
        modelId: input.modelId,
        searchEnabled: searchEnabled!,
        timeZone: input.timeZone,
        openDocumentId: input.openDocumentId,
      });

      return { assistantMessageId: input.assistantMessageId };
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
        deviceSessionId?: string | undefined;
        timeZone?: string | undefined;
        openDocumentId?: string | undefined;
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
        expectedMessages: all,
        userId: input.userId,
        conversationId: input.conversationId,
        assistantMessageId: message.id,
        modelId,
        timeZone: input.timeZone,
        openDocumentId: input.openDocumentId,
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
        /** Folders attached on the machine this edit came from, by name. */
        desktopFolders?: ReadonlyArray<string> | undefined;
        desktopCommands?: boolean | undefined;
        fromDesktop?: boolean | undefined;
        desktopExecutorId?: string | undefined;
        deviceSessionId?: string | undefined;
        timeZone?: string | undefined;
        openDocumentId?: string | undefined;
        attachmentIds: ReadonlyArray<string>;
        /** Omitted keeps the attempt's saved selection; sent replaces it. */
        skillIds?: ReadonlyArray<string> | undefined;
        collectionIds?: ReadonlyArray<string> | undefined;
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
          expectedMessages: all,
          userId: input.userId,
          conversationId: input.conversationId,
          assistantMessageId: assistant.id,
          modelId: input.modelId,
          timeZone: input.timeZone,
          openDocumentId: input.openDocumentId,
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
            fromDesktop: input.fromDesktop,
            desktopExecutorId: input.desktopExecutorId,
            desktopFolders: input.desktopFolders,
            desktopCommands: input.desktopCommands,
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
          searchEnabled: input.searchEnabled,
          researchEnabled,
          ...(input.desktopFolders !== undefined ? { desktopFolders: input.desktopFolders } : {}),
          ...(input.desktopCommands !== undefined
            ? { desktopCommands: input.desktopCommands }
            : {}),
          ...(input.fromDesktop !== undefined ? { fromDesktop: input.fromDesktop } : {}),
          desktopExecutorId: input.desktopExecutorId,
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
        deviceSessionId: input.deviceSessionId,
        userId: input.userId,
        conversationId: input.conversationId,
        messageId: created.message.id,
        generationId: created.message.generationId ?? undefined,
        modelId: input.modelId,
        searchEnabled: created.config.searchEnabled,
        timeZone: input.timeZone,
        openDocumentId: input.openDocumentId,
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
      const stopped = (yield* engine.stopGeneration(input.messageId, input.generationId)) || durable;
      return { stopped };
    });

    const deleteConversation = Effect.fn("ChatService.deleteConversation")(function* (input: {
      userId: string;
      conversationId: string;
    }) {
      const orphanedKeys = yield* repo.deleteConversation(input.userId, input.conversationId);
      yield* attachmentService.deleteBlobs(orphanedKeys);
      yield* sync.publish(input.userId, {
        type: "conversation.deleted",
        conversationId: input.conversationId,
      });
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

    return ChatService.of({
      sendMessage,
      retryMessage,
      branchConversation,
      editMessage,
      stopGeneration,
      deleteConversation,
      updateWorkSettings,
      renameConversation,
    });
  });
}
