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
import { installAgentSelection, resolveEffectiveGeneration } from "./effective-config.ts";
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
type SendTurnInput = Omit<TurnFields, "installAgent" | "resolve"> &
  TurnContent & {
    searchEnabled: boolean;
    timeZone?: string | undefined;
    /** See chat/schema.ts `generationFields.agentId`. */
    agentId?: string | null | undefined;
  };

// Orchestrates the chat use-cases on top of repo + stream engine + sync bus.
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
      | KnowledgeNotAvailable
      | KnowledgeRejected
    >;
    // Regenerates an assistant message in place (same id, fresh stream),
    // deleting every message after it — retry rewinds the conversation.
    retryMessage(input: {
      userId: string;
      conversationId: string;
      messageId: string;
      /** Regenerate with this model instead of the one that answered before. */
      modelId?: string | undefined;
      timeZone?: string | undefined;
    }): Effect.Effect<
      { assistantMessageId: string },
      | ConversationNotFound
      | MessageNotFound
      | ModelNotFound
      | RetryNotAllowed
      | InvalidMessage
      | AttachmentNotAvailable
      | AttachmentUnsupported
      | KnowledgeNotAvailable
    >;
    // Forks the conversation at an assistant message into a new one holding a
    // copy of everything up to it. The source is left untouched.
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
        timeZone?: string | undefined;
        attachmentIds: ReadonlyArray<string>;
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
      | KnowledgeNotAvailable
      | KnowledgeRejected
    >;
    // Winds a streaming assistant message down early, keeping the partial
    // answer. `stopped: false` means there was nothing to stop here.
    stopGeneration(input: {
      generationId?: string | undefined;
      researchRunId?: string | undefined;
      userId: string;
      conversationId: string;
      messageId: string;
    }): Effect.Effect<{ stopped: boolean }, ConversationNotFound | MessageNotFound>;
    deleteConversation(input: { userId: string; conversationId: string }): Effect.Effect<void>;
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
        generationMode?: "chat" | "research" | undefined;
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

        if (input.generationMode === "research") {
          const reader = Option.isSome(urlReaderOption)
            ? yield* urlReaderOption.value.availability()
            : null;
          if (!(yield* searchToolEnabled) || !reader?.configured || !reader.enabled)
            return yield* new InvalidMessage({
              reason: "Deep research requires enabled search and URL reader.",
            });
        }
        if (input.searchEnabled && !(yield* searchToolEnabled)) {
          return yield* new ToolUnavailable({ tool: "web_search", reason: "not enabled" });
        }

        const attachmentFileNames = yield* validateAttachments(
          input.userId,
          model.capabilities,
          input.attachmentIds,
        );

        return { model, attachmentFileNames };
      },
    );

    // Rejects attachments the model cannot read before anything is written, so
    // the user gets a 400 instead of a generation that fails halfway through.
    // Returns their file names in the caller's order — the title generator
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
                "this model cannot read PDFs and document parsing is disabled — enable it in admin settings or pick a model that accepts files",
            });
          }
        }
      }

      return fileNames;
    });

    // Sends a user message; creates the conversation on first message.
    // Returns ids the client needs to subscribe to the assistant stream.
    // The effective configuration is resolved inside the turn's transaction
    // against the (possibly just installed) conversation defaults, so what is
    // stored is exactly what was read. Preferences degrade; access failures
    // fail the whole turn before any row is written.
    const resolver =
      (input: {
        userId: string;
        searchEnabled: boolean;
        model: { contextLength: number | null | undefined };
        searchAvailable: boolean;
        collectionIds?: ReadonlyArray<string> | undefined;
      }): ResolveGeneration =>
      (tx, defaults: ConversationDefaults, continuation) =>
        continuation
          ? knowledge
              .authorizeManifest(
                input.userId,
                continuation.collectionIds,
                continuation.manifest,
                tx,
              )
              .pipe(Effect.as(continuation))
          : resolveEffectiveGeneration({
              tx,
              userId: input.userId,
              agent: defaults.agent,
              collectionIds: input.collectionIds,
              searchEnabled: input.searchEnabled,
              model: input.model,
              searchAvailable: input.searchAvailable,
            }).pipe(Effect.provideService(KnowledgeRepo, knowledge));

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
      let generationMode = input.generationMode ?? "chat";
      if (input.questionResponse && input.conversationId) {
        yield* repo.getConversation(input.userId, input.conversationId);
        generationMode =
          (yield* repo.listMessages(input.conversationId)).at(-1)?.generationMode ?? "chat";
      }
      const { model, attachmentFileNames } = yield* validateGenerationOptions({
        ...input,
        generationMode,
      });
      const searchAvailable = yield* searchToolEnabled;

      // An agent is chosen when a chat starts and pinned from then on: the
      // conversation keeps the installed revision, and neither a swap nor a
      // removal is accepted later. This is what makes an "agent chat" a kind
      // of chat rather than a setting that drifts message by message.
      if (input.agentId !== undefined && input.conversationId && !input.questionResponse)
        return yield* new InvalidMessage({
          reason: "the agent is chosen when a chat starts and cannot change afterwards",
        });
      const agentId = input.questionResponse ? null : input.agentId;

      // One transaction: a lost attachment claim must not leave behind an
      // empty conversation or a user message nobody will answer.
      const turn = yield* repo.createTurn({
        ...input,
        installAgent: agentId
          ? (tx) =>
              installAgentSelection({ tx, userId: input.userId, agentId }).pipe(
                Effect.provideService(AgentRepo, agents),
              )
          : undefined,
        resolve: resolver({
          userId: input.userId,
          searchEnabled: input.searchEnabled,
          model,
          searchAvailable,
          collectionIds: input.collectionIds,
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
        userId: input.userId,
        conversationId: turn.conversation.id,
        messageId: turn.assistant.id,
        researchRunId: turn.assistant.researchRunId ?? undefined,
        generationId: turn.assistant.generationId ?? undefined,
        modelId: input.modelId,
        searchEnabled: turn.config.searchEnabled,
        timeZone: input.timeZone,
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

    const restartAssistant = Effect.fn("ChatService.restartAssistant")(function* (input: {
      expectedMessages: HistorySnapshot;
      userId: string;
      conversationId: string;
      assistantMessageId: string;
      modelId: string;
      searchEnabled: boolean;
      timeZone?: string | undefined;
      deleteMessageIds: ReadonlyArray<string>;
      invalidateCheckpointThroughMessageIds: ReadonlyArray<string>;
      edit?: EditContent & {
        messageId: string;
        attachmentIds: ReadonlyArray<string>;
      };
    }) {
      const { claimed, orphanedKeys, generationId, researchRunId } =
        yield* repo.resetMessageForRetry({
          expectedMessages: input.expectedMessages,
          userId: input.userId,
          messageId: input.assistantMessageId,
          modelId: input.modelId,
          deleteMessageIds: input.deleteMessageIds,
          invalidateCheckpointThroughMessageIds: input.invalidateCheckpointThroughMessageIds,
          searchEnabled: input.searchEnabled,
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
        userId: input.userId,
        conversationId: input.conversationId,
        messageId: input.assistantMessageId,
        researchRunId,
        generationId,
        modelId: input.modelId,
        searchEnabled: input.searchEnabled,
        timeZone: input.timeZone,
      });

      return { assistantMessageId: input.assistantMessageId };
    });

    // Reuses the message row so ids stay stable for subscribers and the
    // sidebar; chunks/tool calls are wiped, later messages deleted, and the
    // stream starts over.
    const retryMessage = Effect.fn("ChatService.retryMessage")(function* (input: {
      userId: string;
      conversationId: string;
      messageId: string;
      modelId?: string | undefined;
      timeZone?: string | undefined;
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
      // streams — its generation fiber would keep writing to deleted rows.
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
      // been deleted — picking another one is the only way to retry it at all.
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

      // Replay the saved snapshot and manifest, with fresh authorization.
      const config = yield* repo.getGenerationConfig(message.id);
      yield* knowledge.authorizeManifest(input.userId, config.collectionIds, config.manifest);
      const usedSearch = (yield* repo.listToolCalls([message.id])).some(
        (call) => call.toolName === "web_search",
      );
      const searchEnabled =
        message.generationMode === "research" || (usedSearch && (yield* searchToolEnabled));
      if (message.generationMode === "research")
        yield* validateGenerationOptions({
          userId: input.userId,
          modelId,
          searchEnabled: false,
          attachmentIds: [],
          generationMode: "research",
        }).pipe(
          Effect.catchTag("ToolUnavailable", (error) =>
            Effect.fail(new InvalidMessage({ reason: error.reason })),
          ),
        );

      const restarted = yield* restartAssistant({
        expectedMessages: all,
        userId: input.userId,
        conversationId: input.conversationId,
        assistantMessageId: message.id,
        modelId,
        searchEnabled,
        timeZone: input.timeZone,
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
      // leave the copy stuck on the placeholder forever — the source's own
      // title fiber only ever writes to the source.
      if (branch.title === null) {
        const seed = prefix.find((m) => m.role === "user");
        const firstAssistant = prefix.find((m) => m.role === "assistant");
        const attachmentFileNames = seed
          ? (yield* attachmentRepo.listForMessages([seed.id])).map((a) => a.fileName)
          : [];
        const titleInput = { content: seed?.content ?? "", attachmentFileNames };
        // The model of the first turn, like sendMessage — not the
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
          // ask — settle on the fallback rather than stay pending.
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
        timeZone?: string | undefined;
        attachmentIds: ReadonlyArray<string>;
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
      const { model } = yield* validateGenerationOptions({
        ...input,
        generationMode: message.generationMode,
      });
      const searchAvailable = yield* searchToolEnabled;
      const edit: EditContent = input.questionResponse
        ? { questionResponse: input.questionResponse }
        : { content: input.content };

      if (assistant) {
        // The edited turn keeps its agent and knowledge context: the row
        // survives with its configuration, re-authorized like a retry.
        const config = yield* repo.getGenerationConfig(assistant.id);
        yield* knowledge.authorizeManifest(input.userId, config.collectionIds, config.manifest);
        const assistantIndex = all.findIndex((candidate) => candidate.id === assistant.id);
        const restarted = yield* restartAssistant({
          expectedMessages: all,
          userId: input.userId,
          conversationId: input.conversationId,
          assistantMessageId: assistant.id,
          modelId: input.modelId,
          searchEnabled: input.searchEnabled && searchAvailable,
          timeZone: input.timeZone,
          deleteMessageIds: all.slice(assistantIndex + 1).map((candidate) => candidate.id),
          // From the edited user message onward — its text changes while the
          // row survives, so any summary covering it is stale.
          invalidateCheckpointThroughMessageIds: all.slice(index).map((candidate) => candidate.id),
          edit: {
            messageId: message.id,
            ...edit,
            attachmentIds: input.attachmentIds,
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
          userId: input.userId,
          searchEnabled: input.searchEnabled,
          model,
          searchAvailable,
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
        userId: input.userId,
        conversationId: input.conversationId,
        messageId: created.message.id,
        researchRunId: created.message.researchRunId ?? undefined,
        generationId: created.message.generationId ?? undefined,
        modelId: input.modelId,
        searchEnabled: created.config.searchEnabled,
        timeZone: input.timeZone,
      });

      return { assistantMessageId: created.message.id };
    });

    const stopGeneration = Effect.fn("ChatService.stopGeneration")(function* (input: {
      generationId?: string | undefined;
      researchRunId?: string | undefined;
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
      // Already finished (or generating on another instance) — the client
      // learns the real state from the `done` event either way.
      if (message.status !== "streaming") return { stopped: false };
      if (message.researchRunId && input.researchRunId !== message.researchRunId)
        return { stopped: false };
      if (
        !message.researchRunId &&
        message.generationId &&
        input.generationId !== message.generationId
      )
        return { stopped: false };
      const durable =
        message.researchRunId && repo.research
          ? yield* repo.research.cancel(message.id, message.researchRunId)
          : false;
      const stopped =
        (yield* engine.stopGeneration(
          input.messageId,
          input.researchRunId ?? input.generationId,
        )) || durable;
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
      renameConversation,
    });
  });
}
