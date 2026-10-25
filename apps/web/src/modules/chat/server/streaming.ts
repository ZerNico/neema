import type { ExternalOwner } from "~/modules/tools/server/external-completion.ts";
import { AgentDraftService } from "~/modules/agents/server/draft-service.ts";
import { DocumentService } from "~/modules/documents/server/document-service.ts";
import { ProjectMemoryService } from "~/modules/projects/server/project-memory.ts";

import { AgentRepo } from "~/modules/agents/server/repo.ts";
import { ScheduleDraftService } from "~/modules/schedules/server/draft-service.ts";
import { KnowledgeRepo } from "~/modules/knowledge/server/repo.ts";
import { SkillReader } from "~/modules/skills/server/reader.ts";
import { lookupsOf } from "../assistant-output.ts";
import { GenerationFence, GenerationSettled, type GenerationIdentity } from "./generation-fence.ts";
import { Context, Deferred, Duration, Effect, Layer, PubSub, Schedule, Stream } from "effect";

import { type PromptDeps } from "./prompt.ts";

import type { PreviewEvent, StatusEvent, StreamEvent } from "./generation/events.ts";
import { makeAttemptUsage, makeGenerationSink, shortErrorMessage } from "./generation/sink.ts";
import { loadAttemptContext, type GenerationInput } from "./generation/attempt-context.ts";
import { generationDeps } from "./generation/deps.ts";
import { prepareGenerationTools } from "./generation/tools.ts";
import { prepareAttemptPrompt } from "./generation/attempt-prompt.ts";
import { runRound } from "./generation/round.ts";

export type {
  ChunkEvent,
  DoneEvent,
  LookupsEvent,
  PreviewEvent,
  StatusEvent,
  StreamEvent,
} from "./generation/events.ts";

/** How often a live tail checks whether its answer settled without it hearing. */
export const SettledCheckInterval = Context.Reference<Duration.Duration>(
  "chat/SettledCheckInterval",
  { defaultValue: () => Duration.seconds(15) },
);

export type StartGenerationInput = GenerationInput & {
  /**
   * Invoked inside the generation fiber once it reaches a terminal status.
   * The engine cannot reach the chat service, so queue dispatch arrives
   * this way rather than through a layer cycle.
   */
  onSettled?: (input: {
    userId: string;
    conversationId: string;
    messageId: string;
    status: "complete" | "error" | "aborted";
  }) => Effect.Effect<void>;
};

/**
 * Runs assistant generations detached from any HTTP request, persists chunks
 * for resumability, and republishes them for live subscribers.
 */
export class StreamEngine extends Context.Service<
  StreamEngine,
  {
    /**
     * Fire-and-forget: start generating the assistant message. Returns once
     * the generation fiber is forked (not when it finishes).
     */
    startGeneration(input: StartGenerationInput): Effect.Effect<void>;
    /**
     * Winds a running generation down early, keeping whatever it has already
     * produced. One whose row exists but whose fiber has not registered yet
     * stops as it registers. False when this instance is not running it now,
     * the same single-instance constraint the live chunk tail has (replay is
     * durable, the in-flight fiber is not).
     */
    stopGeneration(messageId: string, expectedGenerationId?: string): Effect.Effect<boolean>;
    /**
     * Waits until this instance's attempt has finalized: persisted, announced
     * and settled. Returns at once when it is not running here.
     */
    awaitSettled(messageId: string, expectedGenerationId?: string): Effect.Effect<void>;
    /**
     * Settles ordinary generations whose lease lapsed (their process is gone)
     * and notifies subscribers. Runs on a timer; callers may run it on demand.
     */
    reapOrphans: Effect.Effect<void>;
    /**
     * Chunks already persisted after `afterSeq`, then live chunks, then done.
     * Terminates when the message reaches a terminal status.
     */
    subscribe(
      messageId: string,
      afterSeq: number,
      expectedGenerationId?: string,
    ): Stream.Stream<StreamEvent>;
  }
>()("chat/chat/StreamEngine") {
  static readonly layer = Layer.effect(
    StreamEngine,
    Effect.gen(function* () {
      const deps = yield* generationDeps;
      const {
        repo,
        external,
        sync,
        providers,
        customToolRepo,
        policy,
        integrations,
        basePromptDeps,
      } = deps;
      // The latest status of each generation still reading, for a subscriber that joins mid-read.
      const statuses = new Map<string, StatusEvent>();
      // The newest preview of each running image call, by message, so a page
      // that subscribes mid-draw (a reload, a second tab) sees it at once.
      const previews = new Map<string, Map<string, PreviewEvent>>();
      // Sliding, not unbounded: a subscriber that stops reading (stalled SSE
      // connection) must not buffer every in-flight generation's chunks
      // forever. Dropped events are recoverable: resume replays from
      // Postgres by seq, and `done` re-syncs the final row.
      const pubsub = yield* PubSub.sliding<StreamEvent>(4096);

      // messageId -> the deferred its generation races against. Completing it
      // is how "stop" works: the fiber winds itself down and still runs
      // finalize, so the partial answer is persisted and every subscriber
      // gets a `done`. Interrupting the fiber from outside would skip both.
      const inFlight = new Map<
        string,
        {
          abort: Deferred.Deferred<void>;
          /** Completed once finalize has run, for a caller that must wait it out. */
          settled: Deferred.Deferred<void>;
          generationId?: string | undefined;
          owner: ExternalOwner | null;
        }
      >();
      // messageId -> a stop that came before its generation registered (the
      // row commits a few steps before the fiber). The fiber claims it and
      // stops at once. Kept here, not on the chat, so an Undo cannot clear it;
      // an unclaimed one is pruned after a minute.
      const earlyStops = new Map<string, { generationId: string; at: number }>();
      const runtimeScope = yield* Effect.scope;
      // A generation whose process died stays "streaming" forever unless
      // someone settles it: the client cannot stop it (nothing is registered
      // here) and cannot send (the conversation is busy). Settle it from the
      // database clock and tell subscribers, exactly as a crash-time finalize
      // would have.
      const reapGenerations = repo.reapExpiredGenerations().pipe(
        Effect.flatMap((settled) =>
          Effect.forEach(
            settled,
            (row) =>
              PubSub.publish(pubsub, {
                kind: "done",
                messageId: row.messageId,
                ...(row.generationId ? { generationId: row.generationId } : {}),
                status: "error",
              }).pipe(
                Effect.andThen(
                  sync.publish(row.userId, {
                    type: "message.status",
                    conversationId: row.conversationId,
                    messageId: row.messageId,
                    status: "error",
                  }),
                ),
              ),
            { discard: true },
          ),
        ),
        Effect.catchCause((cause) => Effect.logError("generation reconciliation failed", cause)),
      );
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          if (repo.research)
            yield* repo.research
              .reap()
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("research reconciliation failed", cause),
                ),
              );
          yield* reapGenerations;
          for (const owner of yield* external.owners()) {
            if (!(yield* repo.isDesktopAttemptLive(owner))) yield* external.cancelAttempt(owner);
          }
        }).pipe(Effect.delay(Duration.seconds(10)), Effect.forever),
      );

      const runGeneration = Effect.fn("StreamEngine.runGeneration")(function* (
        input: GenerationInput & { abort: Deferred.Deferred<void> },
      ) {
        const ctx = yield* loadAttemptContext(
          { repo, policy, customToolRepo, integrations, providers },
          input,
        );
        if (!ctx) return;
        const { fence, selectedFeatureUnavailable, model, roundLimit, earlierUsage, imageOutput } =
          ctx;
        const usage = makeAttemptUsage();
        const sink = yield* makeGenerationSink({
          repo,
          sync,
          pubsub,
          statuses,
          previews,
          fence,
          userId: input.userId,
          conversationId: input.conversationId,
          messageId: input.messageId,
          modelId: input.modelId,
          model,
          imageOutput,
          usage,
          earlierUsage,
          start: ctx.start,
        });
        // Scanned pages this answer needs are read in the sender's queue,
        // billed to them, and reported live while the answer waits.
        const promptDeps: PromptDeps = {
          ...basePromptDeps,
          parser: {
            availability: basePromptDeps.parser.availability,
            parsePdf: (pdf) =>
              basePromptDeps.parser.parsePdf({
                owner: input.userId,
                onScanProgress: (read, total) =>
                  sink.publishStatus(read < total ? { read, total } : null),
                ...pdf,
              }),
          },
        };

        const generate = Effect.gen(function* () {
          if (selectedFeatureUnavailable)
            return yield* Effect.fail(new Error("A selected feature is no longer available"));
          const tools = yield* prepareGenerationTools(deps, input, ctx, sink, promptDeps);
          const { imageResolver, mapResolver } = tools;
          const attemptPrompt = yield* prepareAttemptPrompt({
            deps,
            input,
            ctx,
            sink,
            usage,
            tools,
            promptDeps,
          });
          const { state } = attemptPrompt;
          for (let round = 0; round <= roundLimit; round++) {
            if (
              (yield* runRound(
                { deps, input, ctx, sink, usage, tools, promptDeps, attemptPrompt },
                round,
              )) === "stop"
            )
              break;
          }
          // Before the scope closes and finalize runs: recording needs the row still streaming.
          yield* Effect.all(
            [imageResolver?.drain ?? Effect.void, mapResolver?.drain ?? Effect.void],
            { concurrency: "unbounded", discard: true },
          );
          // Internal tool rounds need no prose. A validated question is itself the
          // answer; research returns through its own runner before this chat loop.
          // A resumed answer starts from its earlier text, so it is never empty.
          if (
            !state.questionPresented &&
            sink.text().trim().length === 0 &&
            sink.deliveredFiles() === 0
          )
            return yield* Effect.fail(new Error("[ResponseEmpty]"));
        });

        // Periodic flusher so slow generations still persist promptly.
        const flusher = sink.flush.pipe(Effect.delay(Duration.millis(250)), Effect.forever);

        // Stopping wins the race by *succeeding*, not by interrupting from the
        // outside: the model stream is interrupted but finalize still runs, so
        // the text produced so far is persisted and subscribers get a `done`.
        const stopped = Deferred.await(input.abort).pipe(Effect.as(true));
        const ran = generate.pipe(Effect.scoped, Effect.as(false));

        yield* Effect.raceFirst(Effect.raceFirst(ran, stopped), flusher).pipe(
          Effect.flatMap((wasStopped) => sink.finalize(wasStopped ? "aborted" : "complete")),
          Effect.catchCause((cause) => sink.finalize("error", cause)),
          Effect.onInterrupt(() => sink.finalize("error")),
        );
      });

      const startGeneration = Effect.fn("StreamEngine.startGeneration")(function* (
        input: StartGenerationInput,
      ) {
        const abort = yield* Deferred.make<void>();
        const message = yield* repo.getMessage(input.messageId);
        if (message?.generationId !== input.generationId) return;
        const fence: GenerationIdentity = {
          userId: input.userId,
          conversationId: input.conversationId,
          messageId: input.messageId,
          generationId: input.generationId,
        };
        const owner: ExternalOwner | null =
          input.desktop && input.generationId
            ? {
                userId: input.userId,
                conversationId: input.conversationId,
                messageId: input.messageId,
                generationId: input.generationId,
                executorId: input.desktop.executorId,
                deviceSessionId: input.deviceSessionId,
              }
            : null;
        const registration = {
          abort,
          settled: yield* Deferred.make<void>(),
          generationId: fence?.generationId,
          owner,
        };
        inFlight.set(input.messageId, registration);
        // After registering: a stop from now on finds the registration, and
        // one from before it left an early stop to claim.
        const early = earlyStops.get(input.messageId);
        if (early?.generationId === input.generationId) {
          earlyStops.delete(input.messageId);
          yield* Deferred.succeed(abort, undefined);
        }
        // Detached from the request fiber: survives the HTTP response ending.
        yield* Effect.forkIn(
          Effect.gen(function* () {
            if (owner)
              yield* external.track(
                owner,
                sync.publish(input.userId, { type: "desktop.work.changed" }),
              );
            yield* runGeneration({ ...input, abort });
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                yield* Effect.logError("generation startup failed", cause);
                const current = yield* repo.getMessage(input.messageId);
                if (current?.status !== "streaming" || current.generationId !== input.generationId)
                  return;
                yield* repo.failGeneration({
                  messageId: input.messageId,
                  error: shortErrorMessage(cause),
                  ledger: {
                    userId: input.userId,
                    kind: "chat",
                    modelId: input.modelId,
                    modelName: input.modelId,
                    conversationId: input.conversationId,
                    messageId: input.messageId,
                    status: "error",
                    inputTokens: 0,
                    outputTokens: 0,
                    cachedInputTokens: 0,
                    cacheWriteTokens: null,
                    reasoningTokens: 0,
                    usageComplete: false,
                    cost: null,
                    costSource: null,
                  },
                });
                yield* PubSub.publish(pubsub, {
                  kind: "done",
                  messageId: input.messageId,
                  ...(input.generationId ? { generationId: input.generationId } : {}),
                  status: "error",
                });
                yield* sync.publish(input.userId, {
                  type: "message.status",
                  conversationId: input.conversationId,
                  messageId: input.messageId,
                  status: "error",
                });
                yield* (input.onSettled ?? (() => Effect.void))({
                  userId: input.userId,
                  conversationId: input.conversationId,
                  messageId: input.messageId,
                  status: "error",
                });
              }),
            ),
            Effect.scoped,
            Effect.provideService(GenerationFence, fence),
            Effect.provideService(GenerationSettled, input.onSettled ?? (() => Effect.void)),
            Effect.ensuring(
              Deferred.succeed(registration.settled, undefined).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    // Identity-checked: a retry reuses the message id, so this
                    // run must not evict the registration a newer one made.
                    if (inFlight.get(input.messageId) === registration) {
                      inFlight.delete(input.messageId);
                      statuses.delete(input.messageId);
                      previews.delete(input.messageId);
                    }
                  }),
                ),
              ),
            ),
          ),
          runtimeScope,
        );
      });

      const stopGeneration = (
        messageId: string,
        expectedGenerationId?: string,
      ): Effect.Effect<boolean> =>
        Effect.suspend(() => {
          const registration = inFlight.get(messageId);
          if (!registration && expectedGenerationId) {
            const now = Date.now();
            for (const [id, stop] of earlyStops) if (now - stop.at > 60_000) earlyStops.delete(id);
            earlyStops.set(messageId, { generationId: expectedGenerationId, at: now });
          }
          if (!registration || registration.generationId !== expectedGenerationId)
            return Effect.succeed(false);
          return Deferred.succeed(registration.abort, undefined).pipe(
            Effect.tap(() =>
              registration.owner ? external.cancelAttempt(registration.owner) : Effect.void,
            ),
          );
        });

      const awaitSettled = (
        messageId: string,
        expectedGenerationId?: string,
      ): Effect.Effect<void> =>
        Effect.suspend(() => {
          const registration = inFlight.get(messageId);
          if (!registration || registration.generationId !== expectedGenerationId)
            return Effect.void;
          return Deferred.await(registration.settled);
        });

      const subscribe = (
        messageId: string,
        afterSeq: number,
        expectedGenerationId?: string,
      ): Stream.Stream<StreamEvent> =>
        Stream.unwrap(
          Effect.gen(function* () {
            // Subscribe to live events FIRST so nothing falls in the gap
            // between DB replay and live tail. Duplicates are dropped by seq.
            const message = yield* repo.getMessage(messageId).pipe(Effect.orDie);
            if (!message) {
              const done: StreamEvent = { kind: "done", messageId, status: "error" };
              return Stream.make(done);
            }

            const subscription = yield* PubSub.subscribe(pubsub);
            if (message.status === "streaming" && !inFlight.has(messageId)) yield* reapGenerations;
            const current = (yield* repo.getMessage(messageId).pipe(Effect.orDie)) ?? message;
            const generationId = expectedGenerationId ?? current.generationId ?? undefined;
            if (current.generationId && current.generationId !== generationId)
              return Stream.make({
                kind: "done" as const,
                messageId,
                generationId: current.generationId,
                status: "error" as const,
              });
            const persisted = yield* repo.chunksAfter(messageId, afterSeq);
            // Retry replaces chunks and identity atomically. Check again before
            // labeling replay, so rows read across that commit cannot be mixed.
            const afterReplay = yield* repo.getMessage(messageId).pipe(Effect.orDie);
            if (!afterReplay || afterReplay.generationId !== current.generationId)
              return Stream.make({
                kind: "done" as const,
                messageId,
                ...(afterReplay?.generationId ? { generationId: afterReplay.generationId } : {}),
                status: "error" as const,
              });
            let lastSeq = persisted.at(-1)?.seq ?? afterSeq;
            const settledEvery = yield* SettledCheckInterval;

            const replay: Stream.Stream<StreamEvent> = Stream.fromIterable(
              persisted.map((c) => ({
                kind: "chunk" as const,
                ...(generationId ? { generationId } : {}),
                messageId,
                seq: c.seq,
                chunkKind: c.kind,
                delta: c.delta,
                at: c.createdAt.getTime(),
              })),
            );

            if (current.status !== "streaming") {
              const done: StreamEvent = {
                kind: "done",
                messageId,
                ...(generationId ? { generationId } : {}),
                status: current.status,
              };
              return replay.pipe(Stream.concat(Stream.make(done)));
            }

            const status = statuses.get(messageId);
            const toChunk = (c: (typeof persisted)[number]): StreamEvent => ({
              kind: "chunk",
              ...(generationId ? { generationId } : {}),
              messageId,
              seq: c.seq,
              chunkKind: c.kind,
              delta: c.delta,
              at: c.createdAt.getTime(),
            });
            // The PubSub slides, so a slow reader can miss events. Chunks are
            // stored before they are published, so what it missed is read back.
            const missed = (before: number) =>
              repo
                .chunksAfter(messageId, lastSeq)
                .pipe(Effect.map((rows) => rows.filter((c) => c.seq < before).map(toChunk)));
            const inOrder = (event: StreamEvent): Stream.Stream<StreamEvent> =>
              event.kind === "chunk" && event.seq > lastSeq + 1
                ? Stream.unwrap(
                    Effect.map(missed(event.seq), (rows) => Stream.fromIterable([...rows, event])),
                  )
                : Stream.make(event);
            const live: Stream.Stream<StreamEvent> = Stream.fromSubscription(subscription).pipe(
              Stream.filter(
                (event) => event.messageId === messageId && event.generationId === generationId,
              ),
              Stream.filter((event) => event.kind !== "chunk" || event.seq > lastSeq),
              Stream.flatMap(inOrder),
            );
            // A missed `done` would hold the request open, so the row is checked
            // now and then; once settled, the rest is read back and the stream ends.
            const settled: Stream.Stream<StreamEvent> = Stream.fromEffectSchedule(
              repo.getMessage(messageId).pipe(Effect.orDie),
              Schedule.spaced(settledEvery),
            ).pipe(
              Stream.filter(
                (row) =>
                  row?.status !== "streaming" || (row.generationId ?? undefined) !== generationId,
              ),
              Stream.take(1),
              Stream.flatMap((row) =>
                Stream.unwrap(
                  Effect.map(missed(Number.POSITIVE_INFINITY), (rows) =>
                    Stream.fromIterable<StreamEvent>([
                      ...rows,
                      {
                        kind: "done",
                        messageId,
                        ...(generationId ? { generationId } : {}),
                        status:
                          row &&
                          (row.generationId ?? undefined) === generationId &&
                          row.status !== "streaming"
                            ? row.status
                            : "error",
                      },
                    ]),
                  ),
                ),
              ),
            );
            const tail = Stream.merge(live, settled, { haltStrategy: "either" }).pipe(
              Stream.filter((event) => event.kind !== "chunk" || event.seq > lastSeq),
              Stream.tap((event) =>
                Effect.sync(() => {
                  if (event.kind === "chunk") lastSeq = event.seq;
                }),
              ),
              Stream.takeUntil((event) => event.kind === "done"),
            );

            const reading: Stream.Stream<StreamEvent> =
              status && status.generationId === generationId
                ? Stream.make({ kind: "status", ...status })
                : Stream.empty;
            // Read after subscribing, so an image recorded since the loader ran is in one or the other.
            const output = afterReplay.assistantOutput;
            const imageSnapshot: Stream.Stream<StreamEvent> =
              output?.images || output?.places || output?.routes
                ? Stream.make({
                    kind: "lookups",
                    messageId,
                    ...(generationId ? { generationId } : {}),
                    lookups: lookupsOf(output),
                  })
                : Stream.empty;
            const drawing: Stream.Stream<StreamEvent> = Stream.fromIterable(
              [...(previews.get(messageId)?.values() ?? [])]
                .filter((event) => event.generationId === generationId)
                .map((event) => ({ kind: "preview" as const, ...event })),
            );
            return replay.pipe(
              Stream.concat(reading),
              Stream.concat(imageSnapshot),
              Stream.concat(drawing),
              Stream.concat(tail),
            );
          }),
        );

      return StreamEngine.of({
        startGeneration,
        stopGeneration,
        awaitSettled,
        reapOrphans: reapGenerations,
        subscribe,
      });
    }),
  ).pipe(
    Layer.provideMerge(ScheduleDraftService.layer),
    Layer.provideMerge(AgentDraftService.layer),
    Layer.provideMerge(DocumentService.layer),
    Layer.provideMerge(ProjectMemoryService.layer),
    Layer.provideMerge(AgentRepo.layer),
    Layer.provideMerge(KnowledgeRepo.layer),
    Layer.provideMerge(SkillReader.layer),
  );
}
