import { Context, Effect, Layer } from "effect";
import {
  ConversationNotFound,
  EditNotAllowed,
  InvalidMessage,
  MessageNotFound,
  ModelNotFound,
  RetryNotAllowed,
} from "~/modules/chat/errors.ts";
import { attachmentKind, MAX_ATTACHMENTS_PER_MESSAGE } from "~/modules/attachments/constants.ts";
import { AttachmentNotAvailable, AttachmentUnsupported } from "~/modules/attachments/errors.ts";
import { DocumentParser } from "~/modules/attachments/server/document-parser.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { ToolUnavailable, WebSearchExecutor } from "~/modules/tools/server/web-search.ts";
import { ChatRepo } from "./repo.ts";
import { StreamEngine } from "./streaming.ts";

// Orchestrates the chat use-cases on top of repo + stream engine + sync bus.
export class ChatService extends Context.Service<
  ChatService,
  {
    sendMessage(input: {
      userId: string;
      conversationId: string | null;
      modelId: string;
      content: string;
      searchEnabled: boolean;
      attachmentIds: ReadonlyArray<string>;
    }): Effect.Effect<
      { conversationId: string; assistantMessageId: string },
      | ModelNotFound
      | ConversationNotFound
      | ToolUnavailable
      | InvalidMessage
      | AttachmentNotAvailable
      | AttachmentUnsupported
    >;
    // Regenerates an assistant message in place (same id, fresh stream),
    // deleting every message after it — retry rewinds the conversation.
    retryMessage(input: {
      userId: string;
      conversationId: string;
      messageId: string;
    }): Effect.Effect<
      { assistantMessageId: string },
      | ConversationNotFound
      | MessageNotFound
      | ModelNotFound
      | RetryNotAllowed
      | AttachmentNotAvailable
    >;
    editMessage(input: {
      userId: string;
      conversationId: string;
      messageId: string;
      content: string;
      modelId: string;
      searchEnabled: boolean;
      attachmentIds: ReadonlyArray<string>;
    }): Effect.Effect<
      { assistantMessageId: string },
      | ConversationNotFound
      | MessageNotFound
      | ModelNotFound
      | EditNotAllowed
      | ToolUnavailable
      | InvalidMessage
      | AttachmentNotAvailable
      | AttachmentUnsupported
    >;
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
    const attachmentRepo = yield* AttachmentRepo;
    const attachmentService = yield* AttachmentService;
    const documentParser = yield* DocumentParser;

    const validateGenerationOptions = Effect.fn("ChatService.validateGenerationOptions")(
      function* (input: {
        userId: string;
        modelId: string;
        searchEnabled: boolean;
        content: string;
        attachmentIds: ReadonlyArray<string>;
      }) {
        // A turn with neither text nor files has nothing for the model to read.
        if (input.content.trim() === "" && input.attachmentIds.length === 0) {
          return yield* new InvalidMessage({ reason: "message is empty" });
        }
        if (input.attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE) {
          return yield* new InvalidMessage({
            reason: `at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`,
          });
        }

        const model = yield* providers.getModel(input.modelId);
        if (!model || !model.enabled || model.type !== "chat") {
          return yield* new ModelNotFound({ modelId: input.modelId });
        }

        if (input.searchEnabled) {
          if (!model.capabilities.tools) {
            return yield* new ToolUnavailable({
              tool: "web_search",
              reason: "model does not support tool calling",
            });
          }
          const availability = yield* webSearch.availability();
          if (!availability.configured || !availability.enabled) {
            return yield* new ToolUnavailable({ tool: "web_search", reason: "not enabled" });
          }
        }

        yield* validateAttachments(input.userId, model.capabilities, input.attachmentIds);

        return model;
      },
    );

    // Rejects attachments the model cannot read before anything is written, so
    // the user gets a 400 instead of a generation that fails halfway through.
    const validateAttachments = Effect.fn("ChatService.validateAttachments")(function* (
      userId: string,
      capabilities: { vision: boolean; files: boolean },
      attachmentIds: ReadonlyArray<string>,
    ) {
      if (attachmentIds.length === 0) return;

      const rows = yield* attachmentRepo.listWithBlobsByIds(userId, attachmentIds);
      const byId = new Map(rows.map((row) => [row.id, row]));
      // Parsing availability is only consulted once, and only if a PDF meets a
      // model that cannot read files natively.
      let parsing: { configured: boolean; enabled: boolean } | null = null;

      for (const attachmentId of attachmentIds) {
        const row = byId.get(attachmentId);
        if (!row) return yield* new AttachmentNotAvailable({ attachmentId });

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
    });

    // Sends a user message; creates the conversation on first message.
    // Returns ids the client needs to subscribe to the assistant stream.
    const sendMessage = Effect.fn("ChatService.sendMessage")(function* (input: {
      userId: string;
      conversationId: string | null;
      modelId: string;
      content: string;
      searchEnabled: boolean;
      attachmentIds: ReadonlyArray<string>;
    }) {
      // The server stays authoritative even when the composer hides the toggle.
      yield* validateGenerationOptions(input);

      // One transaction: a lost attachment claim must not leave behind an
      // empty conversation or a user message nobody will answer.
      const turn = yield* repo.createTurn({
        userId: input.userId,
        conversationId: input.conversationId,
        modelId: input.modelId,
        content: input.content,
        attachmentIds: input.attachmentIds,
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
        modelId: input.modelId,
        searchEnabled: input.searchEnabled,
      });

      return { conversationId: turn.conversation.id, assistantMessageId: turn.assistant.id };
    });

    const restartAssistant = Effect.fn("ChatService.restartAssistant")(function* (input: {
      userId: string;
      conversationId: string;
      assistantMessageId: string;
      modelId: string;
      searchEnabled: boolean;
      deleteMessageIds: ReadonlyArray<string>;
      edit?: {
        messageId: string;
        content: string;
        attachmentIds: ReadonlyArray<string>;
      };
    }) {
      const { claimed, orphanedKeys } = yield* repo.resetMessageForRetry({
        userId: input.userId,
        messageId: input.assistantMessageId,
        modelId: input.modelId,
        deleteMessageIds: input.deleteMessageIds,
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
        modelId: input.modelId,
        searchEnabled: input.searchEnabled,
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
    }) {
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

      const modelId = message.modelId;
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

      // Re-enable search iff the original generation actually used it and it
      // is still available — a degraded retry beats a failing one.
      const usedSearch = (yield* repo.listToolCalls([message.id])).length > 0;
      const availability = usedSearch ? yield* webSearch.availability() : null;
      const searchEnabled =
        usedSearch &&
        availability !== null &&
        availability.configured &&
        availability.enabled &&
        model.capabilities.tools;

      const restarted = yield* restartAssistant({
        userId: input.userId,
        conversationId: input.conversationId,
        assistantMessageId: message.id,
        modelId,
        searchEnabled,
        deleteMessageIds: after.map((m) => m.id),
      });
      if (!restarted) {
        return yield* new RetryNotAllowed({
          messageId: input.messageId,
          reason: "message is already generating",
        });
      }
      return restarted;
    });

    const editMessage = Effect.fn("ChatService.editMessage")(function* (input: {
      userId: string;
      conversationId: string;
      messageId: string;
      content: string;
      modelId: string;
      searchEnabled: boolean;
      attachmentIds: ReadonlyArray<string>;
    }) {
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
      yield* validateGenerationOptions(input);

      if (assistant) {
        const assistantIndex = all.findIndex((candidate) => candidate.id === assistant.id);
        const restarted = yield* restartAssistant({
          userId: input.userId,
          conversationId: input.conversationId,
          assistantMessageId: assistant.id,
          modelId: input.modelId,
          searchEnabled: input.searchEnabled,
          deleteMessageIds: all.slice(assistantIndex + 1).map((candidate) => candidate.id),
          edit: {
            messageId: message.id,
            content: input.content,
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
        userId: input.userId,
        conversationId: input.conversationId,
        userMessageId: message.id,
        expectedEditedAt: message.editedAt,
        content: input.content,
        attachmentIds: input.attachmentIds,
        modelId: input.modelId,
        deleteMessageIds: after.map((candidate) => candidate.id),
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
        modelId: input.modelId,
        searchEnabled: input.searchEnabled,
      });

      return { assistantMessageId: created.message.id };
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
      editMessage,
      deleteConversation,
      renameConversation,
    });
  });
}
