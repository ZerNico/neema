import { Context, Effect, Layer } from "effect";
import { ConversationNotFound, ModelNotFound } from "~/modules/chat/errors.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
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
    }): Effect.Effect<
      { conversationId: string; assistantMessageId: string },
      ModelNotFound | ConversationNotFound
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

    // Sends a user message; creates the conversation on first message.
    // Returns ids the client needs to subscribe to the assistant stream.
    const sendMessage = Effect.fn("ChatService.sendMessage")(function* (input: {
      userId: string;
      conversationId: string | null;
      modelId: string;
      content: string;
    }) {
      const model = yield* providers.getModel(input.modelId);
      if (!model || !model.enabled || model.type !== "chat") {
        return yield* new ModelNotFound({ modelId: input.modelId });
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
      });

      return { conversationId: conversation.id, assistantMessageId: assistant.id };
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

    return ChatService.of({ sendMessage, deleteConversation, renameConversation });
  });
}
