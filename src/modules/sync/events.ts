import { Schema } from "effect";

// Domain events fanned out to a user's connected browser sessions.
// Payloads carry ids only — clients refetch details via queries. This keeps
// events small enough for Postgres NOTIFY (8kB limit) and avoids stale data.

export const SyncEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("conversation.created"),
    conversationId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("conversation.updated"),
    conversationId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("conversation.deleted"),
    conversationId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("message.created"),
    conversationId: Schema.String,
    messageId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("message.status"),
    conversationId: Schema.String,
    messageId: Schema.String,
    status: Schema.Literals(["streaming", "complete", "error", "aborted"]),
  }),
]);

export type SyncEvent = typeof SyncEvent.Type;

export const UserSyncEnvelope = Schema.Struct({
  userId: Schema.String,
  event: SyncEvent,
});

export type UserSyncEnvelope = typeof UserSyncEnvelope.Type;
