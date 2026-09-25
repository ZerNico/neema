import { Effect, Option } from "effect";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import { ScheduleRepo } from "~/modules/schedules/server/repo.ts";
import { ChatRepo, type QueueGate } from "./repo.ts";
import { StreamEngine } from "./streaming.ts";
import { eq } from "drizzle-orm";
import { projects } from "~/db/schema/index.ts";
import { projectRoleSql } from "~/modules/projects/server/access.ts";
import { Db } from "~/server/db.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";

const reapGenerationsForDetail = (repo: ChatRepo["Service"]) =>
  Effect.gen(function* () {
    const settled = yield* repo.reapExpiredGenerations();
    if (settled.length === 0) return;
    const sync = yield* Effect.serviceOption(SyncBus);
    if (Option.isNone(sync)) return;
    yield* Effect.forEach(
      settled,
      (row) =>
        sync.value.publish(row.userId, {
          type: "message.status",
          conversationId: row.conversationId,
          messageId: row.messageId,
          status: "error",
        }),
      { discard: true },
    );
  }).pipe(Effect.catchCause((cause) => Effect.logError("generation reconciliation failed", cause)));

/**
 * Why the queue is or is not moving, from the same gate promotion reads. Only
 * the browser knows whether it is the desktop app a Work entry needs, so that
 * one reason is added there.
 */
const queueStateOf = (queue: ReadonlyArray<{ lastError: string | null }>, gate: QueueGate) => {
  if (queue.length === 0) return null;
  if (gate === "busy") return "running" as const;
  if (gate === "unsettled") return "stopped" as const;
  if (gate === "question") return "question" as const;
  // Promotion would try it, but it already failed once; a person decides.
  return queue[0]?.lastError ? ("failed" as const) : ("ready" as const);
};

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
  const schedules = yield* ScheduleRepo;
  // Ownership first and alone: an unauthorized id must fail before any of its
  // children are read.
  const conversation = yield* repo.getConversation(userId, conversationId);
  yield* repo.research?.reap() ?? Effect.void;
  const engine = yield* Effect.serviceOption(StreamEngine);
  // Share the engine's terminal event path with live subscribers when present;
  // a standalone detail loader still settles the database row and syncs it.
  if (Option.isSome(engine)) yield* engine.value.reapOrphans;
  else yield* reapGenerationsForDetail(repo);
  // The source of a branch, for the "branched from" link. Read through the
  // same ownership check, and null when it has been deleted since. It depends
  // on the conversation only, so it rides with the messages.
  const { messages, branchedFrom, schedule } = yield* Effect.all(
    {
      messages: repo.listMessages(conversation.id),
      branchedFrom: conversation.branchedFrom
        ? repo.getConversation(userId, conversation.branchedFrom).pipe(
            Effect.map((source) => ({ conversationId: source.id, title: source.title })),
            Effect.catchTag("ConversationNotFound", () => Effect.succeed(null)),
          )
        : Effect.succeed(null),
      // The schedule behind this chat, for the banner link back: one that keeps
      // running here first, else the one whose fire created it. Read optionally
      // like branchedFrom: either may have been deleted since.
      schedule: Effect.gen(function* () {
        const runsHere = yield* schedules.findByChat(userId, conversation.id);
        if (runsHere) return { scheduleId: runsHere.id, name: runsHere.name, runsHere: true };
        const created = conversation.scheduleId
          ? yield* schedules.get(userId, conversation.scheduleId)
          : null;
        return created ? { scheduleId: created.id, name: created.name, runsHere: false } : null;
      }),
    },
    { concurrency: "unbounded" },
  );
  const streaming = messages.find((m) => m.status === "streaming");
  const assistantIds = messages.filter((m) => m.role === "assistant").map((m) => m.id);
  const userIds = messages.filter((m) => m.role === "user").map((m) => m.id);
  // These hang off the same message-id snapshot and nothing else, so they go
  // out together rather than one after the other.
  const {
    pendingChunks,
    toolCalls,
    compactionEvents,
    attachments,
    defaults,
    generations,
    queue,
    queueGate,
  } = yield* Effect.all(
    {
      // For streaming messages the client resumes via SSE using the chunks
      // persisted so far; ship them inline so the first paint is complete.
      pendingChunks: !streaming ? Effect.succeed([]) : repo.chunksAfter(streaming.id, 0),
      // Durable generation activity for all assistant messages. Research
      // compaction bodies stay private; ordinary chat summaries are displayable.
      toolCalls: repo.listToolCalls(assistantIds),
      compactionEvents: repo.listCompactionEvents(assistantIds),
      // Flat, like tool calls. The view groups by messageId.
      attachments: attachmentRepo.listForMessages([...userIds, ...assistantIds]),
      // Only the installed agent persists between turns. Standalone knowledge
      // is message input, not a conversation default.
      defaults: repo.getConversationDefaults(conversation.id),
      // What each answer ran with: the collections (shown on the *question*
      // that added them, like attached files). Snapshot text and document
      // manifests stay server-side; only
      // names travel, resolved client-side against what the viewer may read.
      generations: repo.listGenerationDisplay(assistantIds),
      // Messages waiting behind the live answer. They are conversation state,
      // not transcript rows, so every tab and device sees the same queue.
      queue: repo.listQueue(conversation.id),
      queueGate: repo.queueGate(conversation.id),
    },
    { concurrency: "unbounded" },
  );
  const agentRepo = yield* AgentRepo;
  const liveAgent = defaults.agent?.agentId
    ? yield* agentRepo.get(userId, defaults.agent.agentId)
    : null;
  // Named even when access was lost, so the chat can say where it was.
  const project = conversation.projectId
    ? yield* Effect.flatMap(Db, (db) =>
        db
          .select({ id: projects.id, name: projects.name, role: projectRoleSql(userId) })
          .from(projects)
          .where(eq(projects.id, conversation.projectId!)),
      ).pipe(
        Effect.orDie,
        Effect.map(([row]) => row ?? null),
      )
    : null;
  return {
    conversation,
    agentDrafts: defaults.agentDrafts ?? [],
    scheduleDrafts: defaults.scheduleDrafts ?? [],
    documents: defaults.documents ?? [],
    messages: messages.map(({ providerReplay: _privateReplay, ...message }) => message),
    pendingChunks,
    toolCalls,
    compactionEvents: compactionEvents.map((event) =>
      event.researchRunId ? { ...event, summary: null } : event,
    ),
    attachments,
    branchedFrom,
    schedule,
    agent: defaults.agent
      ? {
          id: defaults.agent.agentId,
          name: liveAgent?.row.name ?? null,
          icon: liveAgent?.row.icon ?? "robot",
          collectionIds: liveAgent?.collectionIds ?? [],
          skillIds: liveAgent?.skillIds ?? [],
          // The composer's resting toggle: the agent's own default, like its model.
          searchEnabled: liveAgent?.row.searchEnabled ?? true,
          available: liveAgent !== null,
        }
      : null,
    generations,
    queue,
    queueState: queueStateOf(queue, queueGate),
    project: project ? { id: project.id, name: project.name, role: project.role } : null,
  };
});
