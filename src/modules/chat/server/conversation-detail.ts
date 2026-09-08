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
  yield* repo.research?.reap() ?? Effect.void;
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
  const { pendingChunks, toolCalls, compactionEvents, attachments, defaults, generations } =
    yield* Effect.all(
      {
        // For streaming messages the client resumes via SSE using the chunks
        // persisted so far; ship them inline so the first paint is complete.
        pendingChunks: !streaming
          ? Effect.succeed([])
          : repo.research
            ? repo.research
                .tail(streaming.id, 0)
                .pipe(
                  Effect.map((snapshot) =>
                    snapshot?.message.generationId === streaming.generationId &&
                    snapshot?.message.researchRunId === streaming.researchRunId
                      ? snapshot.chunks
                      : [],
                  ),
                )
            : repo.chunksAfter(streaming.id, 0),
        // Durable generation activity for all assistant messages. Tool results
        // are summaries only; compaction events carry generated summaries and
        // safe ordering metadata, never the transcript they summarized.
        toolCalls: repo.listToolCalls(assistantIds),
        compactionEvents: repo.listCompactionEvents(assistantIds),
        // Flat, like tool calls — the view groups by messageId.
        attachments: attachmentRepo.listForMessages([...userIds, ...assistantIds]),
        // Only the installed agent persists between turns. Standalone knowledge
        // is message input, not a conversation default.
        defaults: repo.getConversationDefaults(conversation.id),
        // What each answer ran with: the agent (for the answer's label) and the
        // collections (shown on the *question* that added them, like attached
        // files). Snapshot text and document manifests stay server-side; only
        // names travel, resolved client-side against what the viewer may read.
        generations: repo.listGenerationDisplay(assistantIds),
      },
      { concurrency: "unbounded" },
    );
  return {
    conversation,
    messages: messages.map(({ providerReplay: _privateReplay, ...message }) => message),
    pendingChunks,
    toolCalls,
    compactionEvents,
    attachments,
    branchedFrom,
    agent: defaults.agent
      ? {
          id: defaults.agent.agentId,
          name: defaults.agent.snapshot.name,
          icon: defaults.agent.snapshot.icon,
          collectionIds: defaults.agent.snapshot.collectionIds,
        }
      : null,
    generations,
  };
});
