import { Context, Effect, Layer } from "effect";
import {
  ConversationNotFound,
  MessageNotFound,
  ModelNotFound,
  RetryNotAllowed,
} from "~/modules/chat/errors.ts";
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
    }): Effect.Effect<
      { conversationId: string; assistantMessageId: string },
      ModelNotFound | ConversationNotFound | ToolUnavailable
    >;
    // Regenerates an assistant message in place (same id, fresh stream),
    // deleting every message after it — retry rewinds the conversation.
    retryMessage(input: {
      userId: string;
      conversationId: string;
      messageId: string;
    }): Effect.Effect<
      { assistantMessageId: string },
      ConversationNotFound | MessageNotFound | ModelNotFound | RetryNotAllowed
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

    // Sends a user message; creates the conversation on first message.
    // Returns ids the client needs to subscribe to the assistant stream.
    const sendMessage = Effect.fn("ChatService.sendMessage")(function* (input: {
      userId: string;
      conversationId: string | null;
      modelId: string;
      content: string;
      searchEnabled: boolean;
    }) {
      const model = yield* providers.getModel(input.modelId);
      if (!model || !model.enabled || model.type !== "chat") {
        return yield* new ModelNotFound({ modelId: input.modelId });
      }

      // The server stays authoritative even when the composer hides the toggle.
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

      const conversation = input.conversationId
        ? yield* repo.getConversation(input.userId, input.conversationId)
        : yield* repo.createConversation({ userId: input.userId, modelId: input.modelId });

      if (!input.conversationId) {
        yield* sync.publish(input.userId, {
          type: "conversation.created",
          conversationId: conversation.id,
        });
      }

      yield* repo.insertMessage({
        conversationId: conversation.id,
        role: "user",
        content: input.content,
      });

      const assistant = yield* repo.insertMessage({
        conversationId: conversation.id,
        role: "assistant",
        status: "streaming",
        modelId: input.modelId,
      });

      yield* repo.updateConversation(conversation.id, {
        modelId: input.modelId,
        lastMessageAt: new Date(),
      });

      yield* sync.publish(input.userId, {
        type: "message.created",
        conversationId: conversation.id,
        messageId: assistant.id,
      });

      yield* engine.startGeneration({
        userId: input.userId,
        conversationId: conversation.id,
        messageId: assistant.id,
        modelId: input.modelId,
        searchEnabled: input.searchEnabled,
      });

      return { conversationId: conversation.id, assistantMessageId: assistant.id };
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

      yield* repo.deleteMessages(after.map((m) => m.id));
      yield* repo.resetMessageForRetry(message.id);
      yield* sync.publish(input.userId, {
        type: "message.status",
        conversationId: input.conversationId,
        messageId: message.id,
        status: "streaming",
      });

      yield* engine.startGeneration({
        userId: input.userId,
        conversationId: input.conversationId,
        messageId: message.id,
        modelId,
        searchEnabled,
      });

      return { assistantMessageId: message.id };
    });

    const deleteConversation = Effect.fn("ChatService.deleteConversation")(function* (input: {
      userId: string;
      conversationId: string;
    }) {
      yield* repo.deleteConversation(input.userId, input.conversationId);
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

    return ChatService.of({ sendMessage, retryMessage, deleteConversation, renameConversation });
  });
}
