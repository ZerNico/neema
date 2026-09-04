import { Effect } from "effect";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { ChatRepo } from "./repo.ts";

/**
 * Everything the chat view needs for one conversation, in three dependency
 * stages rather than one serial chain of round trips.
 *
 * Lives apart from `functions.ts` so it can be exercised against a real
 * database: the server function there imports the composition root, which
 * builds a live pool at module scope.
 */
export const loadConversationDetail = Effect.fn("chat.loadConversationDetail")(function* (
  userId: string,
  conversationId: string,
) {
  const repo = yield* ChatRepo;
  const attachmentRepo = yield* AttachmentRepo;
  // Ownership first and alone: an unauthorized id must fail before any of its
  // children are read.
  const conversation = yield* repo.getConversation(userId, conversationId);
  // The source of a branch, for the "branched from" link. Read through the
  // same ownership check, and null when it has been deleted since. It depends
  // on the conversation only, so it rides with the messages.
  const { messages, branchedFrom } = yield* Effect.all(
    {
      messages: repo.listMessages(conversation.id),
      branchedFrom: conversation.branchedFrom
        ? repo.getConversation(userId, conversation.branchedFrom).pipe(
            Effect.map((source) => ({ conversationId: source.id, title: source.title })),
            Effect.catchTag("ConversationNotFound", () => Effect.succeed(null)),
          )
        : Effect.succeed(null),
    },
    { concurrency: "unbounded" },
  );
  const streaming = messages.find((m) => m.status === "streaming");
  const assistantIds = messages.filter((m) => m.role === "assistant").map((m) => m.id);
  const userIds = messages.filter((m) => m.role === "user").map((m) => m.id);
  // All four hang off the same message-id snapshot and nothing else, so they go
  // out together rather than one after the other.
  const { pendingChunks, toolCalls, compactionEvents, attachments } = yield* Effect.all(
    {
      // For streaming messages the client resumes via SSE using the chunks
      // persisted so far; ship them inline so the first paint is complete.
      pendingChunks: streaming ? repo.chunksAfter(streaming.id, 0) : Effect.succeed([]),
      // Durable generation activity for all assistant messages. Tool results
      // are summaries only; compaction events carry generated summaries and
      // safe ordering metadata, never the transcript they summarized.
      toolCalls: repo.listToolCalls(assistantIds),
      compactionEvents: repo.listCompactionEvents(assistantIds),
      // Flat, like tool calls — the view groups by messageId.
      attachments: attachmentRepo.listForMessages(userIds),
    },
    { concurrency: "unbounded" },
  );
  return {
    conversation,
    messages,
    pendingChunks,
    toolCalls,
    compactionEvents,
    attachments,
    branchedFrom,
  };
});
