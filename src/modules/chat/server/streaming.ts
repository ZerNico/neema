import { Context, Duration, Effect, Layer, PubSub, Stream } from "effect";
import { AiGateway } from "~/modules/providers/server/gateway.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { ChatRepo } from "./repo.ts";

// Live chunk events fanned out to SSE subscribers on this instance.
// Replay across instances/reloads always comes from Postgres, so this PubSub
// only needs to carry chunks for in-flight generations.
export interface ChunkEvent {
  readonly messageId: string;
  readonly seq: number;
  readonly delta: string;
}

export interface DoneEvent {
  readonly messageId: string;
  readonly status: "complete" | "error" | "aborted";
}

export type StreamEvent =
  | ({ readonly kind: "chunk" } & ChunkEvent)
  | ({ readonly kind: "done" } & DoneEvent);

// Runs assistant generations detached from any HTTP request, persists chunks
// for resumability, and republishes them for live subscribers.
export class StreamEngine extends Context.Service<
  StreamEngine,
  {
    // Fire-and-forget: start generating the assistant message. Returns once
    // the generation fiber is forked (not when it finishes).
    startGeneration(input: {
      userId: string;
      conversationId: string;
      messageId: string;
      modelId: string;
    }): Effect.Effect<void>;
    // Chunks already persisted after `afterSeq`, then live chunks, then done.
    // Terminates when the message reaches a terminal status.
    subscribe(messageId: string, afterSeq: number): Stream.Stream<StreamEvent>;
  }
>()("chat/chat/StreamEngine") {
  static readonly layer = Layer.effect(
    StreamEngine,
    Effect.gen(function* () {
      const repo = yield* ChatRepo;
      const gateway = yield* AiGateway;
      const sync = yield* SyncBus;
      const pubsub = yield* PubSub.unbounded<StreamEvent>();

      const runGeneration = Effect.fn("StreamEngine.runGeneration")(function* (input: {
        userId: string;
        conversationId: string;
        messageId: string;
        modelId: string;
      }) {
        const history = yield* repo.listMessages(input.conversationId);
        const prompt = history
          .filter((m) => m.id !== input.messageId && m.status === "complete")
          .map((m) => ({ role: m.role, content: m.content }));

        let seq = 0;
        let assembled = "";
        let buffer: Array<{ seq: number; delta: string }> = [];

        const flush = Effect.suspend(() => {
          if (buffer.length === 0) return Effect.void;
          const batch = buffer;
          buffer = [];
          return repo.appendChunks(input.messageId, batch);
        });

        const publishChunk = (chunk: { seq: number; delta: string }) =>
          PubSub.publish(pubsub, { kind: "chunk", messageId: input.messageId, ...chunk });

        const finalize = (status: "complete" | "error" | "aborted", error?: unknown) =>
          Effect.gen(function* () {
            yield* flush;
            yield* repo.finalizeMessage({
              messageId: input.messageId,
              status,
              content: assembled,
              ...(error ? { error: { tag: "GenerationFailed", message: String(error) } } : {}),
            });
            yield* repo.updateConversation(input.conversationId, { lastMessageAt: new Date() });
            yield* PubSub.publish(pubsub, { kind: "done", messageId: input.messageId, status });
            yield* sync.publish(input.userId, {
              type: "message.status",
              conversationId: input.conversationId,
              messageId: input.messageId,
              status,
            });
          });

        const consume = gateway.streamChat({ modelId: input.modelId, messages: prompt }).pipe(
          Stream.mapEffect((delta) =>
            Effect.gen(function* () {
              seq += 1;
              assembled += delta.text;
              const chunk = { seq, delta: delta.text };
              buffer.push(chunk);
              yield* publishChunk(chunk);
              // Flush to Postgres in small batches to bound loss on crash
              // without a write per token.
              if (buffer.length >= 16) yield* flush;
            }),
          ),
          Stream.runDrain,
        );

        // Periodic flusher so slow generations still persist promptly.
        const flusher = flush.pipe(Effect.delay(Duration.millis(250)), Effect.forever);

        yield* Effect.raceFirst(consume, flusher).pipe(
          Effect.flatMap(() => finalize("complete")),
          Effect.catchCause((cause) => finalize("error", cause)),
        );
      });

      const startGeneration = Effect.fn("StreamEngine.startGeneration")(function* (input: {
        userId: string;
        conversationId: string;
        messageId: string;
        modelId: string;
      }) {
        // Detached from the request fiber: survives the HTTP response ending.
        yield* Effect.forkDetach(runGeneration(input));
      });

      const subscribe = (messageId: string, afterSeq: number): Stream.Stream<StreamEvent> =>
        Stream.unwrap(
          Effect.gen(function* () {
            // Subscribe to live events FIRST so nothing falls in the gap
            // between DB replay and live tail. Duplicates are dropped by seq.
            const subscription = yield* PubSub.subscribe(pubsub);

            const message = yield* repo.getMessage(messageId).pipe(Effect.orDie);
            if (!message) {
              const done: StreamEvent = { kind: "done", messageId, status: "error" };
              return Stream.make(done);
            }

            const persisted = yield* repo.chunksAfter(messageId, afterSeq);
            let lastSeq = persisted.at(-1)?.seq ?? afterSeq;

            const replay: Stream.Stream<StreamEvent> = Stream.fromIterable(
              persisted.map((c) => ({
                kind: "chunk" as const,
                messageId,
                seq: c.seq,
                delta: c.delta,
              })),
            );

            if (message.status !== "streaming") {
              const done: StreamEvent = { kind: "done", messageId, status: message.status };
              return replay.pipe(Stream.concat(Stream.make(done)));
            }

            const live: Stream.Stream<StreamEvent> = Stream.fromSubscription(subscription).pipe(
              Stream.filter((event) => event.messageId === messageId),
              Stream.filter((event) => event.kind === "done" || event.seq > lastSeq),
              Stream.tap((event) =>
                Effect.sync(() => {
                  if (event.kind === "chunk") lastSeq = event.seq;
                }),
              ),
              Stream.takeUntil((event) => event.kind === "done"),
            );

            return replay.pipe(Stream.concat(live));
          }),
        );

      return StreamEngine.of({ startGeneration, subscribe });
    }),
  );
}
