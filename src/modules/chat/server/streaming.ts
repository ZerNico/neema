import { Context, Deferred, Duration, Effect, Layer, PubSub, Stream } from "effect";
import { Prompt, type Response } from "effect/unstable/ai";
import { uuidv7 } from "uuidv7";
import { BlobStore } from "~/modules/attachments/server/blob-store.ts";
import { DocumentParser } from "~/modules/attachments/server/document-parser.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AiGateway } from "~/modules/providers/server/gateway.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { WebSearchExecutor } from "~/modules/tools/server/web-search.ts";
import type { ToolChunkEnvelope } from "~/modules/tools/schema.ts";
import { buildHistoryMessages, type PromptDeps } from "./prompt.ts";
import { MAX_PRIOR_SOURCES, SEARCH_SYSTEM_HINT, withSearchReminder } from "./search-prompt.ts";
import { ChatRepo, type ChunkKind } from "./repo.ts";

// Live chunk events fanned out to SSE subscribers on this instance.
// Replay across instances/reloads always comes from Postgres, so this PubSub
// only needs to carry chunks for in-flight generations.
export interface ChunkEvent {
  readonly messageId: string;
  readonly seq: number;
  readonly chunkKind: ChunkKind;
  readonly delta: string;
}

export interface DoneEvent {
  readonly messageId: string;
  readonly status: "complete" | "error" | "aborted";
}

export type StreamEvent =
  | ({ readonly kind: "chunk" } & ChunkEvent)
  | ({ readonly kind: "done" } & DoneEvent);

// One assistant message may span several model turns when tools are involved:
// model → tool_calls → execute → feed results back → model continues.
const MAX_TOOL_ROUNDS = 3;

// Message and tool-call rows are shipped to the client wholesale, so the
// stored error must not carry provider stack traces or internal URLs — the
// full cause goes to the server log instead (see finalize).
const shortErrorMessage = (error: unknown): string =>
  String(error).split("\n", 1)[0]!.slice(0, 200);

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
      searchEnabled: boolean;
    }): Effect.Effect<void>;
    // Winds a running generation down early, keeping whatever it has already
    // produced. False when this instance is not the one running it — the same
    // single-instance constraint the live chunk tail has (replay is durable,
    // the in-flight fiber is not).
    stopGeneration(messageId: string): Effect.Effect<boolean>;
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
      const webSearch = yield* WebSearchExecutor;
      const providers = yield* ProviderRepo;
      const promptDeps: PromptDeps = {
        attachments: yield* AttachmentRepo,
        store: yield* BlobStore,
        parser: yield* DocumentParser,
      };
      // Sliding, not unbounded: a subscriber that stops reading (stalled SSE
      // connection) must not buffer every in-flight generation's chunks
      // forever. Dropped events are recoverable — resume replays from
      // Postgres by seq, and `done` re-syncs the final row.
      const pubsub = yield* PubSub.sliding<StreamEvent>(4096);

      // messageId -> the deferred its generation races against. Completing it
      // is how "stop" works: the fiber winds itself down and still runs
      // finalize, so the partial answer is persisted and every subscriber
      // gets a `done`. Interrupting the fiber from outside would skip both.
      const inFlight = new Map<string, Deferred.Deferred<void>>();

      const runGeneration = Effect.fn("StreamEngine.runGeneration")(function* (input: {
        userId: string;
        conversationId: string;
        messageId: string;
        modelId: string;
        searchEnabled: boolean;
        abort: Deferred.Deferred<void>;
      }) {
        const history = yield* repo.listMessages(input.conversationId);
        const completed = history.filter(
          (m) => m.id !== input.messageId && m.status === "complete",
        );

        // Conversation-scoped citations (Onyx-style): gather every source from
        // earlier messages' persisted tool calls. They seed the numbering (so
        // new searches continue the sequence) and, when search is on, a recap
        // block that makes earlier indexes legitimately citable again. History
        // keeps its markers — with the recap present they resolve.
        const priorToolCalls = yield* repo.listToolCalls(
          completed.filter((m) => m.role === "assistant").map((m) => m.id),
        );
        const priorByIndex = new Map<
          number,
          { index: number; url: string; title: string; snippet: string }
        >();
        for (const call of priorToolCalls) {
          const result = call.result as {
            sources?: ReadonlyArray<{ index: number; url: string; title: string; snippet: string }>;
          } | null;
          for (const s of result?.sources ?? []) {
            if (!priorByIndex.has(s.index)) priorByIndex.set(s.index, s);
          }
        }
        const priorSources = [...priorByIndex.values()]
          // oxlint-disable-next-line no-array-sort -- fresh array from Map values
          .sort((a, b) => a.index - b.index);

        let seq = 0;
        let assembled = "";
        let assembledReasoning = "";
        let buffer: Array<{ seq: number; kind: ChunkKind; delta: string }> = [];

        // Persist FIRST, then publish: a subscriber's one-shot DB replay must
        // never miss a chunk that was already announced live.
        // Uninterruptible from the buffer swap on: the periodic flusher loses
        // a race against the generation finishing, and an interrupt between
        // clearing the buffer and the insert would lose that seq range for
        // good (breaking chunk contiguity, which resume relies on).
        const flush = Effect.uninterruptible(
          Effect.suspend(() => {
            if (buffer.length === 0) return Effect.void;
            const batch = buffer;
            buffer = [];
            return repo.appendChunks(input.messageId, batch).pipe(
              Effect.flatMap(() =>
                Effect.forEach(
                  batch,
                  (chunk) =>
                    PubSub.publish(pubsub, {
                      kind: "chunk",
                      messageId: input.messageId,
                      seq: chunk.seq,
                      chunkKind: chunk.kind,
                      delta: chunk.delta,
                    }),
                  { discard: true },
                ),
              ),
            );
          }),
        );

        const pushChunk = (kind: ChunkKind, delta: string) => {
          seq += 1;
          if (kind === "reasoning") assembledReasoning += delta;
          else if (kind === "text") assembled += delta;
          buffer.push({ seq, kind, delta });
        };

        const pushToolChunk = (envelope: ToolChunkEnvelope) =>
          Effect.suspend(() => {
            pushChunk("tool", JSON.stringify(envelope));
            return flush; // tool markers flush immediately so the UI reacts
          });

        const finalize = (
          status: "complete" | "error" | "aborted",
          usage: { inputTokens?: number; outputTokens?: number },
          error?: unknown,
        ) =>
          Effect.gen(function* () {
            yield* flush;
            if (error) {
              yield* Effect.logError("generation failed", {
                messageId: input.messageId,
                cause: String(error),
              });
              yield* repo.failRunningToolCalls(input.messageId, shortErrorMessage(error));
            } else if (status === "aborted") {
              // A tool interrupted mid-flight never reports back; without this
              // its row would stay "running" forever.
              yield* repo.failRunningToolCalls(input.messageId, "stopped");
            }
            yield* repo.finalizeMessage({
              messageId: input.messageId,
              status,
              content: assembled,
              reasoning: assembledReasoning,
              ...(usage.inputTokens !== undefined || usage.outputTokens !== undefined
                ? { usage }
                : {}),
              ...(error
                ? { error: { tag: "GenerationFailed", message: shortErrorMessage(error) } }
                : {}),
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

        // Outside `generate`: a stopped generation is interrupted mid-effect,
        // and the tokens it already burned still have to be recorded.
        const totalUsage: { inputTokens?: number; outputTokens?: number } = {};
        const addUsage = (usage: Response.FinishPart["usage"]) => {
          if (usage.inputTokens.total !== undefined) {
            totalUsage.inputTokens = (totalUsage.inputTokens ?? 0) + usage.inputTokens.total;
          }
          if (usage.outputTokens.total !== undefined) {
            totalUsage.outputTokens = (totalUsage.outputTokens ?? 0) + usage.outputTokens.total;
          }
        };

        const generate = Effect.gen(function* () {
          // Attachments resolve here, inside the generation: a missing blob or
          // an unparseable PDF then finalizes the message as an error like any
          // other generation failure.
          const model = yield* providers.getModel(input.modelId);
          const historyMessages = yield* buildHistoryMessages(promptDeps, {
            messages: completed,
            searchEnabled: input.searchEnabled,
            modelSupportsFiles: model?.capabilities.files ?? false,
          });

          const toolkit = input.searchEnabled
            ? yield* webSearch.prepare({ sources: priorSources })
            : undefined;
          const recapSources = priorSources.slice(-MAX_PRIOR_SOURCES);

          // Search hint + history is the stable prefix. Everything that varies
          // per model turn lives in the reminder appended below, never in here.
          let transcript = Prompt.make([
            ...(toolkit ? [{ role: "system" as const, content: SEARCH_SYSTEM_HINT }] : []),
            ...historyMessages,
          ]);

          for (let turn = 0; turn <= MAX_TOOL_ROUNDS; turn++) {
            const toolRoundsLeft = turn < MAX_TOOL_ROUNDS;
            let finishReason = "unknown";
            let callIndex = 0;
            const turnParts: Response.AnyPart[] = [];
            // provider call id -> our durable row id
            const callRowIds = new Map<string, string>();

            // Rebuilt every round and always last, the way Onyx re-appends its
            // reminder: the recap has to sit behind the tool results it
            // competes with, and the final round must know it has no tool
            // calls left. It is never fed back into the transcript.
            const prompt = toolkit
              ? withSearchReminder(transcript, {
                  sources: recapSources,
                  lastCycle: !toolRoundsLeft,
                })
              : transcript;

            yield* gateway
              .streamChat({
                modelId: input.modelId,
                prompt,
                ...(toolkit && toolRoundsLeft ? { toolkit, toolChoice: "auto" as const } : {}),
              })
              .pipe(
                Stream.mapEffect((part) =>
                  Effect.gen(function* () {
                    // Preliminary tool results are UI progress only — keep them
                    // out of the continuation transcript.
                    const isPreliminary =
                      part.type === "tool-result" &&
                      (part as { preliminary?: boolean }).preliminary === true;
                    if (!isPreliminary) turnParts.push(part);
                    switch (part.type) {
                      case "text-delta": {
                        pushChunk("text", part.delta);
                        if (buffer.length >= 16) yield* flush;
                        return;
                      }
                      case "reasoning-delta": {
                        pushChunk("reasoning", part.delta);
                        if (buffer.length >= 16) yield* flush;
                        return;
                      }
                      case "reasoning-start": {
                        // Hidden-reasoning marker: an empty reasoning chunk lets
                        // the UI show "Thinking…" even if no readable trace follows.
                        pushChunk("reasoning", "");
                        return;
                      }
                      case "tool-call": {
                        const rowId = uuidv7();
                        callRowIds.set(part.id, rowId);
                        const args = part.params as Record<string, unknown>;
                        yield* repo.insertToolCall({
                          id: rowId,
                          messageId: input.messageId,
                          turnIndex: turn,
                          callIndex: callIndex++,
                          providerCallId: part.id,
                          toolName: part.name,
                          arguments: args as never,
                        });
                        yield* pushToolChunk({
                          v: 1,
                          phase: "start",
                          callId: rowId,
                          name: part.name,
                          args: { query: String(args["query"] ?? "") },
                        });
                        return;
                      }
                      case "tool-result": {
                        const rowId = callRowIds.get(part.id) ?? uuidv7();
                        const result = part.result as {
                          ok?: boolean;
                          query?: string;
                          resultCount?: number;
                          pagesFetched?: number;
                          pages?: ReadonlyArray<{
                            url: string;
                            title?: string;
                            status: "pending" | "reading" | "done" | "error";
                          }>;
                          sources?: ReadonlyArray<{
                            index: number;
                            url: string;
                            title: string;
                            snippet: string;
                            read: boolean;
                          }>;
                          error?: string;
                        } | null;
                        const pages = result?.pages ?? [];
                        const sources = result?.sources ?? [];

                        if (isPreliminary) {
                          // Live progress: hits found / page fetch transitions.
                          yield* pushToolChunk({
                            v: 1,
                            phase: "progress",
                            callId: rowId,
                            name: part.name,
                            summary: {
                              query: result?.query ?? "",
                              ...(result?.resultCount !== undefined
                                ? { resultCount: result.resultCount }
                                : {}),
                            },
                            pages,
                          });
                          return;
                        }

                        const ok = !part.isFailure && result?.ok !== false;
                        // Persist summary + source list only — never page bodies.
                        const summary = {
                          query: result?.query ?? "",
                          ...(result?.resultCount !== undefined
                            ? { resultCount: result.resultCount }
                            : {}),
                          ...(result?.pagesFetched !== undefined
                            ? { pagesFetched: result.pagesFetched }
                            : {}),
                        };
                        yield* repo.completeToolCall({
                          id: rowId,
                          result: {
                            ...summary,
                            ...(pages.length > 0 ? { pages } : {}),
                            ...(sources.length > 0 ? { sources } : {}),
                          } as never,
                          status: ok ? "complete" : "error",
                          ...(ok
                            ? {}
                            : {
                                error: {
                                  code: "ToolFailed",
                                  message: result?.error ?? "tool execution failed",
                                },
                              }),
                        });
                        yield* pushToolChunk({
                          v: 1,
                          phase: "result",
                          callId: rowId,
                          name: part.name,
                          ok,
                          summary,
                          ...(pages.length > 0 ? { pages } : {}),
                          ...(sources.length > 0 ? { sources } : {}),
                          ...(ok ? {} : { error: result?.error ?? "tool execution failed" }),
                        });
                        return;
                      }
                      case "finish": {
                        finishReason = part.reason;
                        addUsage(part.usage);
                        return;
                      }
                      case "error": {
                        return yield* Effect.fail(part.error);
                      }
                      default:
                        return;
                    }
                  }),
                ),
                Stream.runDrain,
              );

            if (finishReason !== "tool-calls") break;
            // Feed this turn (assistant tool calls + tool results) back in and
            // let the model continue. The final iteration runs without tools.
            transcript = Prompt.concat(transcript, Prompt.fromResponseParts(turnParts));
          }
        });

        // Periodic flusher so slow generations still persist promptly.
        const flusher = flush.pipe(Effect.delay(Duration.millis(250)), Effect.forever);

        // Stopping wins the race by *succeeding*, not by interrupting from the
        // outside: the model stream is interrupted but finalize still runs, so
        // the text produced so far is persisted and subscribers get a `done`.
        const stopped = Deferred.await(input.abort).pipe(Effect.as(true));
        const ran = generate.pipe(Effect.as(false));

        yield* Effect.raceFirst(Effect.raceFirst(ran, stopped), flusher).pipe(
          Effect.flatMap((wasStopped) => finalize(wasStopped ? "aborted" : "complete", totalUsage)),
          Effect.catchCause((cause) => finalize("error", totalUsage, cause)),
        );
      });

      const startGeneration = Effect.fn("StreamEngine.startGeneration")(function* (input: {
        userId: string;
        conversationId: string;
        messageId: string;
        modelId: string;
        searchEnabled: boolean;
      }) {
        const abort = yield* Deferred.make<void>();
        inFlight.set(input.messageId, abort);
        // Detached from the request fiber: survives the HTTP response ending.
        yield* Effect.forkDetach(
          runGeneration({ ...input, abort }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                // Identity-checked: a retry reuses the message id, so this run
                // must not evict the registration a newer one just made.
                if (inFlight.get(input.messageId) === abort) inFlight.delete(input.messageId);
              }),
            ),
          ),
        );
      });

      const stopGeneration = (messageId: string): Effect.Effect<boolean> =>
        Effect.suspend(() => {
          const abort = inFlight.get(messageId);
          if (!abort) return Effect.succeed(false);
          return Deferred.succeed(abort, undefined);
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
                chunkKind: c.kind,
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

      return StreamEngine.of({ startGeneration, stopGeneration, subscribe });
    }),
  );
}
