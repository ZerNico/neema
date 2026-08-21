import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { runtime } from "~/server/runtime.ts";
import {
  ConversationIdInput,
  RenameConversationInput,
  RetryMessageInput,
  SendMessageInput,
} from "../schema.ts";
import { ChatRepo } from "./repo.ts";
import { ChatService } from "./service.ts";

const standard = Schema.toStandardSchemaV1;

export const listConversations = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runtime.runPromise(ChatRepo.use((repo) => repo.listConversations(context.session.user.id))),
  );

export const getConversationWithMessages = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(standard(ConversationIdInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const conversation = yield* repo.getConversation(
          context.session.user.id,
          data.conversationId,
        );
        const messages = yield* repo.listMessages(conversation.id);
        // For streaming messages the client resumes via SSE using the chunks
        // persisted so far; ship them inline so the first paint is complete.
        const streaming = messages.find((m) => m.status === "streaming");
        const pendingChunks = streaming ? yield* repo.chunksAfter(streaming.id, 0) : [];
        // Durable tool activity for all assistant messages (summaries only).
        const toolCalls = yield* repo.listToolCalls(
          messages.filter((m) => m.role === "assistant").map((m) => m.id),
        );
        return { conversation, messages, pendingChunks, toolCalls };
      }).pipe(
        Effect.catchTag("ConversationNotFound", () =>
          Effect.die(new Response("Not found", { status: 404 })),
        ),
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
          conversationId: data.conversationId,
          modelId: data.modelId,
          content: data.content,
          searchEnabled: data.searchEnabled,
        }),
      ).pipe(
        Effect.catchTags({
          ModelNotFound: () => Effect.die(new Response("Unknown model", { status: 400 })),
          ConversationNotFound: () => Effect.die(new Response("Not found", { status: 404 })),
          ToolUnavailable: (e) =>
            Effect.die(new Response(`Web search unavailable: ${e.reason}`, { status: 400 })),
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
          userId: context.session.user.id,
          conversationId: data.conversationId,
          messageId: data.messageId,
        }),
      ).pipe(
        Effect.catchTags({
          ConversationNotFound: () => Effect.die(new Response("Not found", { status: 404 })),
          MessageNotFound: () => Effect.die(new Response("Not found", { status: 404 })),
          ModelNotFound: () => Effect.die(new Response("Unknown model", { status: 400 })),
          RetryNotAllowed: (e) => Effect.die(new Response(e.reason, { status: 409 })),
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

export const listChatModels = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(() =>
    runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ProviderRepo;
        const models = yield* repo.listModels({ enabledOnly: true });
        return models.filter((m) => m.type === "chat");
      }),
    ),
  );
