import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { runtime } from "~/server/runtime.ts";
import {
  BranchConversationInput,
  ConversationIdInput,
  EditMessageInput,
  ListConversationsInput,
  MessageIdInput,
  RenameConversationInput,
  RetryMessageInput,
  SendMessageInput,
} from "../schema.ts";
import { loadConversationDetail } from "./conversation-detail.ts";
import { ChatRepo } from "./repo.ts";
import { ChatService } from "./service.ts";

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
            ...(data.cursor === undefined
              ? {}
              : { cursor: { activity: new Date(data.cursor.activity), id: data.cursor.id } }),
          })
          // The cursor goes back out exactly as it came in — a string the
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

export const getConversationWithMessages = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(standard(ConversationIdInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      loadConversationDetail(context.session.user.id, data.conversationId).pipe(
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
          attachmentIds: data.attachmentIds,
        }),
      ).pipe(
        Effect.catchTags({
          ModelNotFound: () => Effect.die(new Response("Unknown model", { status: 400 })),
          ConversationNotFound: () => Effect.die(new Response("Not found", { status: 404 })),
          ConversationBusy: () =>
            Effect.die(new Response("A response is still generating", { status: 409 })),
          ToolUnavailable: (e) =>
            Effect.die(new Response(`Web search unavailable: ${e.reason}`, { status: 400 })),
          InvalidMessage: (e) => Effect.die(new Response(e.reason, { status: 400 })),
          AttachmentUnsupported: (e) =>
            Effect.die(new Response(`${e.fileName}: ${e.reason}`, { status: 400 })),
          // Claimed by another message, or gone — the chip is stale either way.
          AttachmentNotAvailable: () =>
            Effect.die(new Response("An attachment is no longer available", { status: 409 })),
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
          modelId: data.modelId,
        }),
      ).pipe(
        Effect.catchTags({
          ConversationNotFound: () => Effect.die(new Response("Not found", { status: 404 })),
          MessageNotFound: () => Effect.die(new Response("Not found", { status: 404 })),
          ModelNotFound: () => Effect.die(new Response("Unknown model", { status: 400 })),
          RetryNotAllowed: (e) => Effect.die(new Response(e.reason, { status: 409 })),
          AttachmentNotAvailable: () =>
            Effect.die(new Response("An attachment is no longer available", { status: 409 })),
          AttachmentUnsupported: (e) =>
            Effect.die(new Response(`${e.fileName}: ${e.reason}`, { status: 400 })),
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
          userId: context.session.user.id,
          conversationId: data.conversationId,
          messageId: data.messageId,
          content: data.content,
          modelId: data.modelId,
          searchEnabled: data.searchEnabled,
          attachmentIds: data.attachmentIds,
        }),
      ).pipe(
        Effect.catchTags({
          ConversationNotFound: () => Effect.die(new Response("Not found", { status: 404 })),
          MessageNotFound: () => Effect.die(new Response("Not found", { status: 404 })),
          ModelNotFound: () => Effect.die(new Response("Unknown model", { status: 400 })),
          ToolUnavailable: (e) =>
            Effect.die(new Response(`Web search unavailable: ${e.reason}`, { status: 400 })),
          EditNotAllowed: (e) => Effect.die(new Response(e.reason, { status: 409 })),
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
  .handler(({ context }) =>
    runtime.runPromise(
      // Filtered to what THIS user may see: public models plus private ones
      // shared with a group they belong to (admins see everything). The rows
      // carry the provider's display name — the picker groups by it.
      ProviderRepo.use((repo) => repo.listChatModelsFor(context.session.user.id)),
    ),
  );
