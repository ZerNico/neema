import { Schema } from "effect";
import { AppNotification } from "~/modules/notifications/schema.ts";

/**
 * Domain events fanned out to a user's connected browser sessions.
 * Payloads carry ids only, so clients refetch details via queries. This keeps
 * events small enough for Postgres NOTIFY (8kB limit) and avoids stale data.
 */

export const SyncEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("sync.ready") }),
  Schema.Struct({ type: Schema.Literal("account.approval.changed") }),
  Schema.Struct({ type: Schema.Literal("desktop.work.changed") }),
  Schema.Struct({
    type: Schema.Literal("draft.changed"),
    kind: Schema.Literals(["agent", "schedule"]),
    conversationId: Schema.String,
    draftId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("schedule.changed"),
    scheduleId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("schedule.run.changed"),
    scheduleId: Schema.String,
    runId: Schema.String,
  }),
  // Exactly one owner: the chat, or the project whose members all hear of it.
  Schema.Struct({
    type: Schema.Literal("document.changed"),
    conversationId: Schema.optionalKey(Schema.String),
    projectId: Schema.optionalKey(Schema.String),
    documentId: Schema.String,
  }),
  // Settings, members, memory or the set of chats moved in or out.
  Schema.Struct({ type: Schema.Literal("project.changed"), projectId: Schema.String }),
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
    type: Schema.Literal("conversation.queue.changed"),
    conversationId: Schema.String,
  }),
  // Deleted by its owner, still restorable for a grace period.
  Schema.Struct({
    type: Schema.Literal("conversation.deleted"),
    conversationId: Schema.String,
  }),
  // Gone for good: a delete past its grace period or an expired temporary chat.
  Schema.Struct({
    type: Schema.Literal("conversation.purged"),
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
  Schema.Struct({ type: Schema.Literal("sidebar.changed") }),
  Schema.Struct({
    type: Schema.Literal("models.defaults.changed"),
  }),
  // A connection, its preferences, or (globally) an integration's setup changed.
  Schema.Struct({ type: Schema.Literal("integrations.changed") }),
  // An integration call started or stopped waiting for the user's decision.
  Schema.Struct({
    type: Schema.Literal("integration.approval.changed"),
    conversationId: Schema.String,
  }),
  // The id is a random per-ticket handle, never the code or its hash, so a
  // tab showing that code can react without the event revealing anything.
  Schema.Struct({
    type: Schema.Literal("desktop.session.created"),
    ticketId: Schema.String,
  }),
  // The one event carrying content: a notification is shown, not refetched,
  // and it never changes after it is sent. Its fields are capped well under
  // the NOTIFY limit.
  Schema.Struct({ type: Schema.Literal("notification"), notification: AppNotification }),
]);

export type SyncEvent = typeof SyncEvent.Type;

/**
 * Most events target one user's browser sessions. Instance-wide policy changes
 * use the global variant so every authenticated SSE subscriber can refetch its
 * own authorized view without enumerating users or putting data on the wire.
 */
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
