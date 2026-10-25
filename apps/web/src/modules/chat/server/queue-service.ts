import type { QueuedTurnInput } from "../queued-turn.ts";
import { Duration, Effect } from "effect";
import {
  ConversationNotFound,
  InvalidMessage,
  ModelNotFound,
  QueueEntryNotFound,
  WorkDesktopRequired,
} from "~/modules/chat/errors.ts";
import { AttachmentNotAvailable, AttachmentUnsupported } from "~/modules/attachments/errors.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { ToolUnavailable } from "~/modules/tools/server/web-search.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { ChatRepo, type ResolveError } from "./repo.ts";
import { StreamEngine, type StartGenerationInput } from "./streaming.ts";
import type { AttemptOptions } from "./attempt-options.ts";
import type { DesktopSubmission } from "../schema.ts";
import type { makeConversationLifecycle } from "./conversation-lifecycle.ts";

/** A text-and-files submission held for later, with the settings it was made under. */
export type QueueSubmission = {
  userId: string;
  conversationId: string;
  content: string;
  attachmentIds: ReadonlyArray<string>;
  input: QueuedTurnInput;
  /** Present when queued from the desktop app; a Work chat requires it. */
  desktop?: DesktopSubmission | undefined;
};

export type QueueSubmissionError =
  | ModelNotFound
  | ToolUnavailable
  | InvalidMessage
  | WorkDesktopRequired
  | AttachmentUnsupported
  | AttachmentNotAvailable;

/** What the queue strip says when a queued message could not start. */
const queueFailure = (error: { readonly _tag: string }) => {
  switch (error._tag) {
    case "AttachmentUnsupported":
    case "AttachmentNotAvailable":
      return "A file in this message can’t be read by its model anymore. Edit it or remove it.";
    case "AccountIneligible":
      return "This account can’t start messages. Try Send now after access is restored.";
    case "ModelNotFound":
      return "This message’s model is no longer available. Edit it to pick another.";
    case "UsageLimitReached":
      return "reason" in error && typeof error.reason === "string"
        ? error.reason
        : "You’ve reached a usage limit.";
    default:
      return "This message could not be started. Its model or collections may no longer be available.";
  }
};

/**
 * Messages held behind the live answer: queueing, editing and removing them,
 * steering one into the answer, and starting the next once it settles.
 */
export const makeQueueService = (deps: {
  options: AttemptOptions;
  stopGeneration: Effect.Success<typeof makeConversationLifecycle>["stopGeneration"];
  announceStarted: (
    userId: string,
    conversationId: string,
    messageId: string,
  ) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const repo = yield* ChatRepo;
    const providers = yield* ProviderRepo;
    const engine = yield* StreamEngine;
    const sync = yield* SyncBus;
    const attachmentService = yield* AttachmentService;
    const policy = yield* FeaturePolicy;
    const { validateGenerationOptions, validateAttachments, searchToolEnabled, resolver } =
      deps.options;
    const { stopGeneration, announceStarted } = deps;

    // Recovers queues a restart or a reaped generation left waiting: the
    // in-process completion hook is gone with the fiber that owned it, and the
    // promotion transaction refuses anything the hook would have refused. Work
    // chats are not swept; only a desktop app can start them.
    const startQueueSweeper = (interval: Duration.Duration) =>
      Effect.forkScoped(
        Effect.gen(function* () {
          const pending = yield* repo.listQueuedConversations({ limit: 20, mode: "chat" });
          yield* Effect.forEach(pending, (row) => drainQueue(row.userId, row.conversationId), {
            discard: true,
          });
        }).pipe(
          Effect.catchCause((cause) => Effect.logError("queue sweep failed", cause)),
          Effect.delay(interval),
          Effect.forever,
        ),
      );

    /**
     * Everything a send would check, run now while the person is still looking
     * at the composer. Dispatch checks again, since a model or a collection can
     * go away while the message waits.
     */
    const validateQueueSubmission = Effect.fn("ChatService.validateQueueSubmission")(function* (
      input: QueueSubmission,
    ) {
      if (input.content.trim() === "" && input.attachmentIds.length === 0)
        return yield* new InvalidMessage({ reason: "message is empty" });
      const conversation = yield* repo.getConversation(input.userId, input.conversationId);
      if (conversation.mode === "work" && !(yield* policy.can(input.userId, "work")))
        return yield* new InvalidMessage({ reason: "Work is not permitted" });
      // Queued Work runs on a machine, so it can only be handed over from one.
      if (conversation.mode === "work" && !input.desktop) return yield* new WorkDesktopRequired();
      yield* validateGenerationOptions({
        userId: input.userId,
        modelId: input.input.modelId,
        searchEnabled: input.input.searchEnabled,
        researchEnabled: input.input.researchEnabled,
        reasoningEffort: input.input.reasoningEffort,
        attachmentIds: input.attachmentIds,
      });
    });

    const queueChanged = (userId: string, conversationId: string) =>
      sync.publish(userId, { type: "conversation.queue.changed", conversationId });

    const queueMessage = Effect.fn("ChatService.queueMessage")(function* (input: QueueSubmission) {
      yield* validateQueueSubmission(input);
      const entry = yield* repo.enqueue({
        userId: input.userId,
        conversationId: input.conversationId,
        content: input.content.trim(),
        attachmentIds: input.attachmentIds,
        input: input.input,
      });
      yield* queueChanged(input.userId, input.conversationId);
      // The answer it was queued behind may have finished while this request
      // was in flight; waiting for the sweep would stall it for no reason.
      yield* drainQueue(input.userId, input.conversationId);
      return { entryId: entry.id };
    });

    const replaceQueuedMessage = Effect.fn("ChatService.replaceQueuedMessage")(function* (
      input: QueueSubmission & { entryId: string },
    ) {
      yield* validateQueueSubmission(input);
      const orphaned = yield* repo.replaceQueueEntry({
        userId: input.userId,
        conversationId: input.conversationId,
        entryId: input.entryId,
        content: input.content.trim(),
        attachmentIds: input.attachmentIds,
        input: input.input,
      });
      yield* attachmentService.deleteBlobs(orphaned);
      yield* queueChanged(input.userId, input.conversationId);
      // Editing is how a person fixes an entry that could not start; with its
      // error cleared it may start now rather than at the next sweep.
      yield* drainQueue(input.userId, input.conversationId);
    });

    const removeQueuedMessage = Effect.fn("ChatService.removeQueuedMessage")(function* (input: {
      userId: string;
      conversationId: string;
      entryId: string;
    }) {
      const orphaned = yield* repo.removeQueueEntry(input);
      yield* attachmentService.deleteBlobs(orphaned);
      yield* queueChanged(input.userId, input.conversationId);
    });

    const steerQueuedMessage = Effect.fn("ChatService.steerQueuedMessage")(function* (input: {
      userId: string;
      conversationId: string;
      entryId: string;
      messageId: string;
      generationId: string;
    }) {
      yield* repo.getConversation(input.userId, input.conversationId);
      // A steer joins an answer already running on its own model, which may
      // not be the one the entry was queued with. Its files have to be
      // readable by that model, or the continuation would fail mid-answer.
      const running = yield* repo.getMessage(input.messageId);
      const entry = (yield* repo.listQueue(input.conversationId)).find(
        (item) => item.id === input.entryId,
      );
      if (!entry) return yield* new QueueEntryNotFound({ entryId: input.entryId });
      const model = running?.modelId ? yield* providers.getModel(running.modelId) : null;
      if (model && entry.attachments.length > 0)
        yield* validateAttachments(
          input.userId,
          model.capabilities,
          entry.attachments.map((file) => file.id),
        ).pipe(
          Effect.catchTag("AttachmentNotAvailable", () =>
            Effect.fail(new QueueEntryNotFound({ entryId: input.entryId })),
          ),
        );
      yield* repo.steerQueueEntry({ ...input, expectedRevision: entry.revision });
      yield* queueChanged(input.userId, input.conversationId);
    });

    const startNextQueued = Effect.fn("ChatService.startNextQueued")(function* (input: {
      userId: string;
      conversationId: string;
      force?: boolean | undefined;
      entryId?: string | undefined;
      /**
       * What the dispatching app reports now: its folders, whether it can
       * sandbox, and which running app it is. A Work entry needs it.
       */
      desktop?: DesktopSubmission | undefined;
      /** See `ExternalOwner.deviceSessionId`; from the session, never the body. */
      deviceSessionId?: string | undefined;
    }): Effect.fn.Return<
      { started: boolean },
      | ConversationNotFound
      | ModelNotFound
      | ToolUnavailable
      | AttachmentNotAvailable
      | AttachmentUnsupported
      | ResolveError
    > {
      const conversation = yield* repo.getConversation(input.userId, input.conversationId);
      // Not an error: the entry simply waits for a desktop app to pick it up.
      if (conversation.mode === "work" && !input.desktop) return { started: false };
      const queue = yield* repo.listQueue(input.conversationId);
      const head = input.entryId ? queue.find((entry) => entry.id === input.entryId) : queue[0];
      if (!head || (head.lastError && !(input.force && input.entryId))) return { started: false };
      return yield* Effect.gen(function* () {
        const { model, researchEnabled } = yield* validateGenerationOptions({
          userId: input.userId,
          modelId: head.input.modelId,
          searchEnabled: head.input.searchEnabled,
          researchEnabled: head.input.researchEnabled,
          attachmentIds: head.attachments.map((file) => file.id),
        });
        const searchAvailable = yield* searchToolEnabled;
        const outcome = yield* repo.promoteNextQueuedTurn({
          userId: input.userId,
          conversationId: input.conversationId,
          expectedEntryId: head.id,
          expectedRevision: head.revision,
          ...(input.entryId ? { jumpQueue: true } : {}),
          ...(input.force ? { force: true } : {}),
          resolve: (entry) =>
            resolver({
              attempt: "queued",
              userId: input.userId,
              model,
              searchAvailable,
              imageModelId: entry.input.imageModelId,
              searchEnabled: entry.input.searchEnabled,
              researchEnabled,
              reasoningEffort: entry.input.reasoningEffort,
              collectionIds: entry.input.collectionIds,
              skillIds: entry.input.skillIds,
              // Taken from the dispatching app now, never from queue time.
              desktop: input.desktop,
            }),
        });
        // A replacement or reordered head needs fresh validation on the next dispatch.
        if (!outcome.promoted) return { started: false };
        yield* announceStarted(input.userId, input.conversationId, outcome.assistant.id);
        yield* queueChanged(input.userId, input.conversationId);
        yield* startAttempt({
          userId: input.userId,
          conversationId: input.conversationId,
          messageId: outcome.assistant.id,
          generationId: outcome.assistant.generationId,
          modelId: outcome.entry.input.modelId,
          timeZone: outcome.entry.input.timeZone,
          openDocument: outcome.entry.input.openDocument,
          desktop: input.desktop,
          deviceSessionId: input.deviceSessionId,
        });
        return { started: true };
      }).pipe(
        Effect.tapError((error) =>
          Effect.gen(function* () {
            yield* repo.setQueueEntryError(head.id, head.revision, queueFailure(error));
            yield* queueChanged(input.userId, input.conversationId);
          }),
        ),
      );
    });

    /**
     * Every path that starts a queued message goes through here, so a head
     * whose model, files or collections went away is annotated whoever tried:
     * the server's own drain, a desktop app, or a person pressing the button.
     * The entry is kept, never dropped.
     */
    const dispatchQueuedMessage = (input: Parameters<typeof startNextQueued>[0]) =>
      startNextQueued(input);

    const sendQueuedNow = Effect.fn("ChatService.sendQueuedNow")(function* (input: {
      userId: string;
      conversationId: string;
      entryId: string;
      /**
       * What the dispatching app reports now: its folders, whether it can
       * sandbox, and which running app it is. A Work entry needs it.
       */
      desktop?: DesktopSubmission | undefined;
      /** See `ExternalOwner.deviceSessionId`; from the session, never the body. */
      deviceSessionId?: string | undefined;
    }) {
      const conversation = yield* repo.getConversation(input.userId, input.conversationId);
      // Only a desktop app can start Work. Without one, stopping the answer
      // would leave nothing running and the message still waiting.
      if (conversation.mode === "work" && !input.desktop) return { started: false };
      const live = (yield* repo.listMessages(input.conversationId)).find(
        (message) => message.status === "streaming",
      );
      if (live) {
        const generationId = live.generationId ?? undefined;
        yield* stopGeneration({
          userId: input.userId,
          conversationId: input.conversationId,
          messageId: live.id,
          generationId,
        });
        // Finalize is quick, but the promotion must see the stopped row. A
        // stall leaves the entry queued for Send next rather than hanging.
        yield* engine
          .awaitSettled(live.id, generationId)
          .pipe(Effect.timeout(Duration.seconds(10)), Effect.ignore);
      }
      // A person asked for this one, so it may start after the stop.
      return yield* dispatchQueuedMessage({ ...input, force: true });
    });

    /**
     * Starts an answer's generation. Once it completes cleanly the next queued
     * message starts; a stop or a failure leaves the queue to the person.
     * `onSettled` runs first, however the answer ended.
     */
    const startAttempt = (
      input: Omit<StartGenerationInput, "generationId" | "onSettled"> & {
        generationId: string | null | undefined;
        onSettled?: Effect.Effect<void> | undefined;
      },
    ) =>
      Effect.gen(function* () {
        // Every answer row is written with its generation; only rows older
        // than the column lack one, and those never start again.
        if (!input.generationId)
          return yield* Effect.die(new Error("An answer started without a generation"));
        yield* engine.startGeneration({
          ...input,
          generationId: input.generationId,
          onSettled: ({ status }) =>
            (input.onSettled ?? Effect.void).pipe(
              Effect.andThen(
                status === "complete"
                  ? drainQueue(input.userId, input.conversationId)
                  : Effect.void,
              ),
            ),
        });
      });

    /** Dispatch that never fails its caller; the reason is already on the entry. */
    const drainQueue = (userId: string, conversationId: string): Effect.Effect<void> =>
      Effect.suspend(() => dispatchQueuedMessage({ userId, conversationId })).pipe(
        Effect.asVoid,
        Effect.catch((error) =>
          Effect.logError("queued message dispatch failed", { conversationId, error }),
        ),
      );

    return {
      queueMessage,
      replaceQueuedMessage,
      removeQueuedMessage,
      steerQueuedMessage,
      dispatchQueuedMessage,
      sendQueuedNow,
      drainQueue,
      startAttempt,
      startQueueSweeper,
    };
  });
