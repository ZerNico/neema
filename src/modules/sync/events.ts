import { Schema } from "effect";

// Domain events fanned out to a user's connected browser sessions.
// Payloads carry ids only — clients refetch details via queries. This keeps
// events small enough for Postgres NOTIFY (8kB limit) and avoids stale data.

export const SyncEvent = Schema.Union([
  // No resource ids or titles: every client refetches only its authorized view.
  Schema.Struct({ type: Schema.Literal("resources.changed") }),
  // Frequent worker transitions affect knowledge status only, not access policy.
  Schema.Struct({ type: Schema.Literal("knowledge.index.changed") }),
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
  Schema.Struct({
    type: Schema.Literal("memory.changed"),
  }),
  Schema.Struct({
    type: Schema.Literal("memory.policy.changed"),
  }),
  Schema.Struct({
    type: Schema.Literal("models.defaults.changed"),
  }),
]);

export type SyncEvent = typeof SyncEvent.Type;

// Most events target one user's browser sessions. Instance-wide policy changes
// use the global variant so every authenticated SSE subscriber can refetch its
// own authorized view without enumerating users or putting data on the wire.
export const SyncEnvelope = Schema.Union([
  Schema.Struct({
    scope: Schema.Literal("user"),
    userId: Schema.String,
    event: SyncEvent,
  }),
  Schema.Struct({
    scope: Schema.Literal("global"),
    event: SyncEvent,
  }),
]);

export type SyncEnvelope = typeof SyncEnvelope.Type;
