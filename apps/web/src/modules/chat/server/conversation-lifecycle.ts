import { Duration, Effect, Schedule } from "effect";
import { InvalidMessage, MessageNotFound } from "~/modules/chat/errors.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { ChatRepo } from "./repo.ts";
import { StreamEngine } from "./streaming.ts";

/**
 * What happens to a chat as a whole: stopping its answer, deleting and
 * restoring it, renaming, keeping, archiving, and the sweep that purges it.
 */
export const makeConversationLifecycle = Effect.gen(function* () {
  const repo = yield* ChatRepo;
  const engine = yield* StreamEngine;
  const sync = yield* SyncBus;
  const attachmentService = yield* AttachmentService;

  const stopGeneration = Effect.fn("ChatService.stopGeneration")(function* (input: {
    generationId?: string | undefined;
    userId: string;
    conversationId: string;
    messageId: string;
  }) {
    yield* repo.research?.reap() ?? Effect.void;
    // ownership check
    yield* repo.getConversation(input.userId, input.conversationId);
    // A Stop on a generation nobody is running is the user telling us the
    // process died. If the lease has lapsed, settle it now instead of waiting
    // for the timer; if it is still live elsewhere, the fence protects it.
    yield* engine.reapOrphans;
    const message = yield* repo.getMessage(input.messageId);
    if (!message || message.conversationId !== input.conversationId) {
      return yield* new MessageNotFound({ messageId: input.messageId });
    }
    // Already finished (or generating on another instance). The client
    // learns the real state from the `done` event either way.
    if (message.status !== "streaming") return { stopped: false };
    if (message.generationId && input.generationId !== message.generationId)
      return { stopped: false };
    // Stop ends the attempt; any run it started is cancelled with it.
    const durable =
      message.generationId && repo.research
        ? yield* repo.research.cancelForGeneration(message.id, message.generationId)
        : false;
    const stopped = (yield* engine.stopGeneration(input.messageId, input.generationId)) || durable;
    return { stopped };
  });

  const deleteConversation = Effect.fn("ChatService.deleteConversation")(function* (input: {
    userId: string;
    conversationId: string;
  }) {
    // Marked first: every way an answer starts locks the chat as owned and
    // not deleted, so nothing new begins once this commits, and the list
    // below is complete. A repeated delete returns the same mark and stops
    // again, so a retry finishes what a failed one left.
    const mark = yield* repo.trashConversation(input.userId, input.conversationId);
    if (mark === null) return null;
    yield* sync.publish(input.userId, {
      type: "conversation.deleted",
      conversationId: input.conversationId,
    });
    // Stopped the way Stop stops one, then awaited, so the answer has settled
    // as stopped before the client offers an Undo that brings it back. One
    // not started yet stops as it starts (`StreamEngine.stopGeneration`). A
    // failure here still leaves the chat deleted, so its Undo stays offered.
    yield* repo.listLiveAnswers(input.conversationId).pipe(
      Effect.flatMap((live) =>
        Effect.forEach(
          live,
          (answer) =>
            Effect.gen(function* () {
              const runId = answer.generationId ?? undefined;
              if (answer.generationId && repo.research)
                yield* repo.research.cancelForGeneration(answer.messageId, answer.generationId);
              yield* engine.stopGeneration(answer.messageId, runId);
              // Awaited even when another Stop got there first and is still settling.
              yield* engine
                .awaitSettled(answer.messageId, runId)
                .pipe(Effect.timeoutOption(Duration.seconds(10)));
            }),
          { discard: true },
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logError("stopping a deleted chat's answers failed", cause),
      ),
    );
    return mark;
  });

  const restoreConversation = Effect.fn("ChatService.restoreConversation")(function* (input: {
    userId: string;
    conversationId: string;
    mark: string;
  }) {
    const restored = yield* repo.restoreConversation(
      input.userId,
      input.conversationId,
      input.mark,
    );
    if (restored)
      yield* sync.publish(input.userId, {
        type: "conversation.updated",
        conversationId: input.conversationId,
      });
    return restored;
  });

  const updateWorkSettings = Effect.fn("ChatService.updateWorkSettings")(function* (input: {
    userId: string;
    conversationId: string;
    permissionLevel: "manual" | "auto" | "skip";
  }) {
    const conversation = yield* repo.getConversation(input.userId, input.conversationId);
    if (conversation.mode !== "work")
      return yield* new InvalidMessage({ reason: "only a work chat has work settings" });
    yield* repo.updateConversation(input.conversationId, {
      permissionLevel: input.permissionLevel,
    });
    yield* sync.publish(input.userId, {
      type: "conversation.updated",
      conversationId: input.conversationId,
    });
  });

  const renameConversation = Effect.fn("ChatService.renameConversation")(function* (input: {
    userId: string;
    conversationId: string;
    title: string;
  }) {
    yield* repo.research?.reap() ?? Effect.void;
    // ownership check
    yield* repo.getConversation(input.userId, input.conversationId);
    yield* repo.updateConversation(input.conversationId, { title: input.title });
    yield* sync.publish(input.userId, {
      type: "conversation.updated",
      conversationId: input.conversationId,
    });
  });

  const markRead = Effect.fn("ChatService.markRead")(function* (input: {
    userId: string;
    conversationId: string;
  }) {
    if (yield* repo.markRead(input.userId, input.conversationId))
      yield* sync.publish(input.userId, {
        type: "conversation.updated",
        conversationId: input.conversationId,
      });
  });

  const keepConversation = Effect.fn("ChatService.keepConversation")(function* (input: {
    userId: string;
    conversationId: string;
  }) {
    yield* repo.getConversation(input.userId, input.conversationId);
    if (yield* repo.keepConversation(input.userId, input.conversationId))
      yield* sync.publish(input.userId, {
        type: "conversation.updated",
        conversationId: input.conversationId,
      });
  });

  const setArchived = Effect.fn("ChatService.setArchived")(function* (input: {
    userId: string;
    conversationId: string;
    archived: boolean;
  }) {
    yield* repo.getConversation(input.userId, input.conversationId);
    if (yield* repo.setArchived(input.userId, input.conversationId, input.archived))
      yield* sync.publish(input.userId, {
        type: "conversation.updated",
        conversationId: input.conversationId,
      });
  });

  const archiveAll = Effect.fn("ChatService.archiveAll")(function* (input: { userId: string }) {
    const ids = yield* repo.archiveAll(input.userId);
    // One event is enough: every tab refreshes its chat lists and details by
    // key prefix, whichever chat an update names.
    if (ids.length > 0)
      yield* sync.publish(input.userId, {
        type: "conversation.updated",
        conversationId: ids[0]!,
      });
    return ids.length;
  });

  const listArchived = Effect.fn("ChatService.listArchived")(function* (input: { userId: string }) {
    return yield* repo.listArchived(input.userId);
  });

  // Purges deleted chats past their grace period and expired temporary
  // ones, so research, attachments and every open tab settle one way.
  const sweepExpired = Effect.fn("ChatService.sweepExpired")(function* () {
    const expired = yield* repo.listExpired(100);
    for (const { id } of expired) {
      const purged = yield* repo.purgeExpired(id);
      if (!purged) continue;
      yield* attachmentService.deleteBlobs(purged.keys);
      yield* sync.publish(purged.userId, { type: "conversation.purged", conversationId: id });
    }
  });

  const startSweeper = (interval: Duration.Duration) =>
    sweepExpired().pipe(
      Effect.catchCause((cause) => Effect.logError("expired chat sweep failed", cause)),
      // Failed calls' full arguments are kept a week, then go the same way.
      Effect.andThen(
        repo
          .sweepFailedCallArguments()
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logError("failed call arguments sweep failed", cause),
            ),
          ),
      ),
      // A settled answer is read from its row, so its chunks only serve a
      // late reconnect, and an hour covers that.
      Effect.andThen(
        repo
          .sweepCompletedChunks()
          .pipe(Effect.catchCause((cause) => Effect.logError("chunk sweep failed", cause))),
      ),
      Effect.repeat(Schedule.spaced(interval)),
      Effect.forkScoped,
    );

  return {
    stopGeneration,
    deleteConversation,
    restoreConversation,
    updateWorkSettings,
    renameConversation,
    keepConversation,
    markRead,
    setArchived,
    archiveAll,
    listArchived,
    sweepExpired,
    startSweeper,
  };
});
