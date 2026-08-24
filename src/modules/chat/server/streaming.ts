import { Context, Deferred, Duration, Effect, Layer, PubSub, Stream } from "effect";
import { Prompt, type Response } from "effect/unstable/ai";
import { uuidv7 } from "uuidv7";
import { AnalyticsRepo } from "~/modules/analytics/server/repo.ts";
import { addFinishUsage, emptyUsageTotals, resolveCost } from "~/modules/analytics/server/usage.ts";
import { BlobStore } from "~/modules/attachments/server/blob-store.ts";
import { DocumentParser } from "~/modules/attachments/server/document-parser.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AiGateway, ProviderContextOverflow } from "~/modules/providers/server/gateway.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { createSourceIndexer } from "~/modules/tools/server/source-indexer.ts";
import { prepareWebToolkit } from "~/modules/tools/server/toolset.ts";
import { createUrlAuthority } from "~/modules/tools/server/url-authority.ts";
import { UrlReaderExecutor } from "~/modules/tools/server/url-reader.ts";
import { extractUserMessageUrls } from "~/modules/tools/server/user-urls.ts";
import { WebSearchExecutor } from "~/modules/tools/server/web-search.ts";
import type { ToolChunkEnvelope } from "~/modules/tools/schema.ts";
import type { CompactionChunkEnvelope } from "../schema.ts";
import {
  calibrationFactor,
  compileActivePrompt,
  estimatePromptTokens,
  prepareCompactedActiveRounds,
  prepareCompactedHistory,
  shrinkForOverflow,
  type ActiveRound,
  type ActiveRoundCompactionDecision,
  type CompactionDecision,
} from "./compaction.ts";
import { buildHistoryMessages, type PromptDeps } from "./prompt.ts";
import {
  buildSearchReminder,
  MAX_PRIOR_SOURCES,
  systemReminderMessage,
  webToolsSystemHint,
} from "./search-prompt.ts";
import { ChatRepo, type ChunkKind } from "./repo.ts";
import type { JsonValue } from "~/db/schema/providers.ts";

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
const MAX_TOOL_ROUNDS = 4;

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
      const urlReader = yield* UrlReaderExecutor;
      const providers = yield* ProviderRepo;
      const analytics = yield* AnalyticsRepo;
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
        // Snapshot the model row up front: the ledger wants its display name
        // and pricing even if the admin deletes or reprices it mid-generation.
        const model = yield* providers.getModel(input.modelId);
        const history = yield* repo.listMessages(input.conversationId);
        const completed = history.filter(
          (m) => m.id !== input.messageId && m.status === "complete",
        );
        const readerUrls = extractUserMessageUrls(completed);

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

        // Calibrates the token estimator: the newest answer that recorded what
        // the provider counted for its first model call, against what we had
        // predicted for that same prompt.
        const priorUsage =
          completed
            .filter((m) => m.role === "assistant" && m.usage?.firstInputTokens !== undefined)
            .at(-1)?.usage ?? null;

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

        const pushCompactionChunk = (envelope: CompactionChunkEnvelope) =>
          Effect.suspend(() => {
            pushChunk("compaction", JSON.stringify(envelope));
            return flush; // same reason as tool markers, only more so: this
          }); //          is the only thing on screen while it runs

        const finalize = (status: "complete" | "error" | "aborted", error?: unknown) =>
          Effect.gen(function* () {
            yield* flush;
            if (error) {
              yield* Effect.logError("generation failed", {
                messageId: input.messageId,
                cause: String(error),
              });
              yield* repo.failRunningToolCalls(input.messageId, shortErrorMessage(error));
              yield* repo.failRunningCompactionEvents(input.messageId, shortErrorMessage(error));
            } else if (status === "aborted") {
              // A tool interrupted mid-flight never reports back; without this
              // its row would stay "running" forever.
              yield* repo.failRunningToolCalls(input.messageId, "stopped");
              yield* repo.failRunningCompactionEvents(input.messageId, "stopped");
            }
            yield* repo.finalizeMessage({
              messageId: input.messageId,
              status,
              content: assembled,
              reasoning: assembledReasoning,
              ...(totals.sawUsage
                ? {
                    usage: {
                      inputTokens: totals.inputTokens,
                      outputTokens: totals.outputTokens,
                      // Only useful as a pair; either alone calibrates nothing.
                      ...(firstInputTokens !== undefined && estimatedFirstInputTokens !== undefined
                        ? { firstInputTokens, estimatedFirstInputTokens }
                        : {}),
                    },
                  }
                : {}),
              ...(error
                ? { error: { tag: "GenerationFailed", message: shortErrorMessage(error) } }
                : {}),
            });
            // Append-only ledger row for this attempt — a retry writes a new
            // one rather than touching this record.
            yield* analytics.record({
              userId: input.userId,
              kind: "chat",
              modelId: model ? input.modelId : null,
              modelName: model?.displayName ?? input.modelId,
              conversationId: input.conversationId,
              messageId: input.messageId,
              status,
              inputTokens: totals.inputTokens,
              outputTokens: totals.outputTokens,
              cachedInputTokens: totals.cachedInputTokens,
              reasoningTokens: totals.reasoningTokens,
              ...resolveCost(totals, model?.pricing),
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
        // and the tokens it already burned still have to be recorded. A turn
        // interrupted before its finish part contributes nothing — the
        // provider never sent the numbers.
        const totals = emptyUsageTotals();
        // The estimator's calibration pair, persisted at finalize: what the
        // provider counted for the first model call, and what we predicted for
        // that same prompt. Only the first call maps onto one prompt —
        // `totals.inputTokens` sums every tool round.
        let sawFirstFinish = false;
        let firstInputTokens: number | undefined;
        let estimatedFirstInputTokens: number | undefined;

        const generate = Effect.gen(function* () {
          // Attachments resolve here, inside the generation: a missing blob or
          // an unparseable PDF then finalizes the message as an error like any
          // other generation failure.
          const model = yield* providers.getModel(input.modelId);

          // One indexer and one URL authority for the whole generation. Search
          // hits extend the reader's authority immediately, while user URLs and
          // earlier persisted sources seed it for direct reads and follow-ups.
          const authority = createUrlAuthority([
            ...readerUrls,
            ...priorSources.map((source) => source.url),
          ]);
          const webTools = model?.capabilities.tools
            ? yield* prepareWebToolkit({
                webSearch,
                urlReader,
                indexer: createSourceIndexer(priorSources),
                authority,
                requestSearch: input.searchEnabled,
              })
            : undefined;
          const toolkit = webTools?.toolkit;

          // Keyed off the armed toolkit, not the search toggle: the reader
          // alone can resolve citations, so history markers stay meaningful.
          const historyMessages = yield* buildHistoryMessages(promptDeps, {
            webToolsEnabled: webTools !== undefined,
            messages: completed,
            modelSupportsFiles: model?.capabilities.files ?? false,
          });
          const sourcesByIndex = new Map(priorSources.map((source) => [source.index, source]));
          const recapSources = () => {
            const sources = [...sourcesByIndex.values()];
            // oxlint-disable-next-line no-array-sort -- fresh array from Map values
            sources.sort((a, b) => a.index - b.index);
            return sources.slice(-MAX_PRIOR_SOURCES);
          };
          const sourceManifest = () =>
            recapSources()
              .map((source) => `[${source.index}] ${source.title} — ${source.url}`)
              .join("\n");
          const reminderPrompt = (lastCycle: boolean) =>
            toolkit
              ? Prompt.make([
                  systemReminderMessage(
                    buildSearchReminder({ sources: recapSources(), lastCycle }),
                  ),
                ])
              : null;

          // Tools hint + history is the stable prefix. Everything that varies
          // per model turn lives in the reminder appended below, never in here.
          const fixedPrefix = webTools
            ? [{ role: "system" as const, content: webToolsSystemHint(webTools.tools) }]
            : [];

          // Synchronously, before a single token streams: a summary written
          // after the answer would be a summary of the wrong prompt. Failure
          // here (nothing left to drop) finalizes the message as an error.
          let compaction: CompactionDecision = yield* prepareCompactedHistory(
            { gateway, repo, providers, analytics },
            {
              userId: input.userId,
              conversationId: input.conversationId,
              messageId: input.messageId,
              modelId: input.modelId,
              contextLength: model?.contextLength,
              messages: completed,
              renderedMessages: historyMessages,
              fixedPrefix,
              ...(reminderPrompt(false)
                ? {
                    trailingMessages: reminderPrompt(false)!
                      .content as unknown as ReadonlyArray<Prompt.MessageEncoded>,
                  }
                : {}),
              webToolsEnabled: webTools !== undefined,
              priorUsage,
              onCompaction: (event) => pushCompactionChunk({ v: 1, ...event }),
            },
          );

          const buildBaseTranscript = () =>
            Prompt.make([
              ...fixedPrefix,
              ...compaction.injectedMessages,
              ...historyMessages.slice(compaction.startIndex),
            ]);
          let activeSummary: string | null = null;
          let activeRounds: ReadonlyArray<ActiveRound> = [];
          const buildTranscript = () =>
            compileActivePrompt({
              basePrompt: buildBaseTranscript(),
              summary: activeSummary,
              rounds: activeRounds,
            });

          let transcript = buildTranscript();
          const estimateRequestPrompt = (lastCycle: boolean) => {
            const trailing = reminderPrompt(lastCycle);
            return estimatePromptTokens([
              ...(transcript.content as unknown as ReadonlyArray<Prompt.MessageEncoded>),
              ...(trailing
                ? (trailing.content as unknown as ReadonlyArray<Prompt.MessageEncoded>)
                : []),
            ]);
          };
          // Persist the raw estimate of the exact first request. The provider's
          // actual/raw pair then learns one stable calibration multiplier.
          estimatedFirstInputTokens = estimateRequestPrompt(false);
          // Pass indexes are local to one before-turn position. Turn 0 reserves
          // pass 0 for the initial history planner, whether or not it emitted.
          const nextPassByTurn = new Map<number, number>([[0, 1]]);
          const nextPassIndex = (beforeTurnIndex: number) => {
            const next = nextPassByTurn.get(beforeTurnIndex) ?? 0;
            nextPassByTurn.set(beforeTurnIndex, next + 1);
            return next;
          };
          const recordHardTruncation = (beforeTurnIndex: number) =>
            Effect.gen(function* () {
              const eventId = uuidv7();
              const position = {
                beforeTurnIndex,
                passIndex: nextPassIndex(beforeTurnIndex),
                scope: "history" as const,
              };
              yield* repo.createCompactionEvent({
                id: eventId,
                messageId: input.messageId,
                ...position,
              });
              yield* pushCompactionChunk({ v: 1, phase: "start", eventId, ...position });
              yield* repo.completeCompactionEvent({
                id: eventId,
                status: "complete",
                outcome: "hard_truncation",
              });
              yield* pushCompactionChunk({
                v: 1,
                phase: "result",
                eventId,
                ...position,
                ok: true,
                outcome: "hard_truncation",
              });
            });

          for (let turn = 0; turn <= MAX_TOOL_ROUNDS; turn++) {
            const toolRoundsLeft = turn < MAX_TOOL_ROUNDS;
            let finishReason = "unknown";
            let callIndex = 0;
            const turnParts: Response.AnyPart[] = [];
            // provider call id -> our durable row id
            const callRowIds = new Map<string, string>();
            let providerOutputStarted = false;
            const currentReminderPrompt = () => reminderPrompt(!toolRoundsLeft);
            const requestPrompt = () => {
              const trailing = currentReminderPrompt();
              return trailing ? Prompt.concat(transcript, trailing) : transcript;
            };

            // Suspended so an overflow retry re-reads the shrunken transcript
            // rather than the one the provider just rejected.
            const drain = Effect.suspend(() =>
              gateway
                .streamChat({
                  modelId: input.modelId,
                  // Rebuilt every round and always last: the recap has to sit
                  // behind the tool results it competes with. It is budgeted but
                  // never fed back into the continuation transcript.
                  prompt: requestPrompt(),
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
                      if (part.type !== "error" && part.type !== "finish") {
                        providerOutputStarted = true;
                      }
                      if (!isPreliminary && part.type !== "error") turnParts.push(part);
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
                            arguments: args as JsonValue,
                          });
                          const targets = Array.isArray(args["queries"])
                            ? args["queries"].map(String)
                            : Array.isArray(args["urls"])
                              ? args["urls"].map(String)
                              : [];
                          yield* pushToolChunk({
                            v: 1,
                            phase: "start",
                            callId: rowId,
                            name: part.name,
                            turnIndex: turn,
                            callIndex: callIndex - 1,
                            args: { targets },
                          });
                          return;
                        }
                        case "tool-result": {
                          const rowId = callRowIds.get(part.id) ?? uuidv7();
                          const result = part.result as {
                            ok?: boolean;
                            targets?: ReadonlyArray<string>;
                            resultCount?: number;
                            pagesFetched?: number;
                            pages?: ReadonlyArray<{
                              url: string;
                              title?: string;
                              status: "pending" | "reading" | "done" | "error";
                              error?: string;
                            }>;
                            sources?: ReadonlyArray<{
                              index: number;
                              url: string;
                              title: string;
                              snippet: string;
                              read: boolean;
                            }>;
                            failures?: ReadonlyArray<{ target: string; error: string }>;
                            error?: string;
                          } | null;
                          const pages = result?.pages ?? [];
                          const sources = result?.sources ?? [];
                          const failures = result?.failures ?? [];

                          if (!isPreliminary) {
                            for (const source of sources) {
                              if (!sourcesByIndex.has(source.index)) {
                                sourcesByIndex.set(source.index, source);
                              }
                            }
                          }

                          if (isPreliminary) {
                            // Live progress: hits found / page fetch transitions.
                            yield* pushToolChunk({
                              v: 1,
                              phase: "progress",
                              callId: rowId,
                              name: part.name,
                              summary: {
                                targets: result?.targets ?? [],
                                ...(result?.resultCount !== undefined
                                  ? { resultCount: result.resultCount }
                                  : {}),
                                ...(result?.pagesFetched !== undefined
                                  ? { pagesFetched: result.pagesFetched }
                                  : {}),
                              },
                              pages,
                            });
                            return;
                          }

                          const ok = !part.isFailure && result?.ok !== false;
                          // Persist summary + source list only — never page bodies.
                          const summary = {
                            targets: result?.targets ?? [],
                            ...(result?.resultCount !== undefined
                              ? { resultCount: result.resultCount }
                              : {}),
                            ...(result?.pagesFetched !== undefined
                              ? { pagesFetched: result.pagesFetched }
                              : {}),
                          };
                          yield* repo.completeToolCall({
                            id: rowId,
                            // Schema-validated tool output — plain JSON at runtime,
                            // but readonly arrays and optional keys keep TS from
                            // proving it against the recursive JsonValue type.
                            result: {
                              ...summary,
                              ...(pages.length > 0 ? { pages } : {}),
                              ...(sources.length > 0 ? { sources } : {}),
                              ...(failures.length > 0 ? { failures } : {}),
                            } as unknown as JsonValue,
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
                            ...(failures.length > 0 ? { failures } : {}),
                            ...(ok ? {} : { error: result?.error ?? "tool execution failed" }),
                          });
                          return;
                        }
                        case "finish": {
                          finishReason = part.reason;
                          addFinishUsage(totals, part);
                          if (!sawFirstFinish) {
                            sawFirstFinish = true;
                            firstInputTokens = part.usage.inputTokens.total;
                          }
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
                ),
            );

            const currentCalibration = () =>
              firstInputTokens !== undefined && estimatedFirstInputTokens !== undefined
                ? calibrationFactor({ firstInputTokens, estimatedFirstInputTokens })
                : calibrationFactor(priorUsage);

            // Two bounded recovery stages: first reduce complete active rounds,
            // then old history. A retry remains safe only while this provider
            // call has emitted no user-visible or tool output.
            const runProviderCall = (recoveryStage: number): Effect.Effect<void, unknown> =>
              drain.pipe(
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    const untouched = !providerOutputStarted && turnParts.length === 0;
                    if (
                      !(error instanceof ProviderContextOverflow) ||
                      !untouched ||
                      recoveryStage >= 2
                    ) {
                      return yield* Effect.fail(error);
                    }

                    const factor = currentCalibration();
                    const beforeEstimate = Math.ceil(
                      estimateRequestPrompt(!toolRoundsLeft) * factor,
                    );
                    if (recoveryStage === 0 && activeRounds.length > 0) {
                      const reduced: ActiveRoundCompactionDecision =
                        yield* prepareCompactedActiveRounds(
                          { gateway, repo, providers, analytics },
                          {
                            userId: input.userId,
                            conversationId: input.conversationId,
                            messageId: input.messageId,
                            modelId: input.modelId,
                            contextLength: model?.contextLength,
                            webToolsEnabled: webTools !== undefined,
                            basePrompt: buildBaseTranscript(),
                            summary: activeSummary,
                            rounds: activeRounds,
                            beforeTurnIndex: turn,
                            passIndex: nextPassIndex(turn),
                            calibrationFactor: factor,
                            sourceManifest: sourceManifest(),
                            ...(currentReminderPrompt()
                              ? { trailingPrompt: currentReminderPrompt()! }
                              : {}),
                            force: true,
                            onCompaction: (event) => pushCompactionChunk({ v: 1, ...event }),
                          },
                        );
                      if (reduced.compacted && reduced.estimatedInputTokens < beforeEstimate) {
                        activeSummary = reduced.summary;
                        activeRounds = reduced.rounds;
                        transcript = buildTranscript();
                        yield* Effect.logInfo(
                          "context overflow, retrying after compacting tool rounds",
                          { messageId: input.messageId, turn },
                        );
                        return yield* runProviderCall(1);
                      }
                    }

                    const activeOnly = compileActivePrompt({
                      basePrompt: Prompt.make([]),
                      summary: activeSummary,
                      rounds: activeRounds,
                    });
                    const trailing = currentReminderPrompt();
                    const shrunk = shrinkForOverflow({
                      decision: compaction,
                      messages: completed,
                      renderedMessages: historyMessages,
                      fixedPrefix: [
                        ...fixedPrefix,
                        ...(activeOnly.content as unknown as ReadonlyArray<Prompt.MessageEncoded>),
                      ],
                      ...(trailing
                        ? {
                            trailingMessages:
                              trailing.content as unknown as ReadonlyArray<Prompt.MessageEncoded>,
                          }
                        : {}),
                      calibrationFactor: factor,
                    });
                    if (!shrunk) return yield* Effect.fail(error);

                    compaction = { ...compaction, ...shrunk, mode: "truncated" };
                    transcript = buildTranscript();
                    if (turn === 0) {
                      estimatedFirstInputTokens = estimateRequestPrompt(!toolRoundsLeft);
                    }
                    yield* recordHardTruncation(turn);
                    yield* Effect.logInfo("context overflow, retrying with fewer history turns", {
                      messageId: input.messageId,
                      turn,
                      startIndex: shrunk.startIndex,
                    });
                    return yield* runProviderCall(2);
                  }),
                ),
              );

            yield* runProviderCall(0);

            if (finishReason !== "tool-calls") break;
            // A completed response/tool batch is one atomic unit. It becomes
            // eligible for compaction only now, after every tool result is
            // terminal; no call can ever be separated from its result.
            activeRounds = [
              ...activeRounds,
              { turnIndex: turn, prompt: Prompt.fromResponseParts(turnParts) },
            ];
            transcript = buildTranscript();

            // Re-budget before every continuation call. The helper accepts a
            // pass only when the exact prompt (trailing reminder included) gets
            // smaller, so repeated passes cannot loop on a verbose summary.
            while (true) {
              const factor =
                firstInputTokens !== undefined && estimatedFirstInputTokens !== undefined
                  ? calibrationFactor({ firstInputTokens, estimatedFirstInputTokens })
                  : calibrationFactor(priorUsage);
              const trailing = reminderPrompt(turn + 1 >= MAX_TOOL_ROUNDS);
              const reduced: ActiveRoundCompactionDecision = yield* prepareCompactedActiveRounds(
                { gateway, repo, providers, analytics },
                {
                  userId: input.userId,
                  conversationId: input.conversationId,
                  messageId: input.messageId,
                  modelId: input.modelId,
                  contextLength: model?.contextLength,
                  webToolsEnabled: webTools !== undefined,
                  basePrompt: buildBaseTranscript(),
                  summary: activeSummary,
                  rounds: activeRounds,
                  beforeTurnIndex: turn + 1,
                  passIndex: nextPassIndex(turn + 1),
                  calibrationFactor: factor,
                  sourceManifest: sourceManifest(),
                  ...(trailing ? { trailingPrompt: trailing } : {}),
                  onCompaction: (event) => pushCompactionChunk({ v: 1, ...event }),
                },
              );
              if (!reduced.compacted) break;

              activeSummary = reduced.summary;
              activeRounds = reduced.rounds;
              transcript = buildTranscript();
            }
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
          Effect.flatMap((wasStopped) => finalize(wasStopped ? "aborted" : "complete")),
          Effect.catchCause((cause) => finalize("error", cause)),
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
