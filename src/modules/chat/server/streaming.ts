import { messageChunks } from "~/db/schema/chat.ts";
import { runResearch } from "./research/runner.ts";
import type { ResearchPhase } from "../research-schema.ts";
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Layer,
  Option,
  PubSub,
  Schema,
  Stream,
  Semaphore,
  Schedule,
} from "effect";
import {
  AskUserParams,
  AskUserResult,
  formatQuestionContext,
  readPresentedQuestions,
} from "~/modules/tools/ask-user-schema.ts";
import { prepareAskUserTool } from "~/modules/tools/server/ask-user.ts";
import { Prompt, type Response } from "effect/unstable/ai";
import { uuidv7 } from "uuidv7";
import { AnalyticsRepo } from "~/modules/analytics/server/repo.ts";
import { addFinishUsage, emptyUsageTotals, resolveCost } from "~/modules/analytics/server/usage.ts";
import { BlobStore } from "~/modules/attachments/server/blob-store.ts";
import { DocumentParser } from "~/modules/attachments/server/document-parser.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AiGateway, ProviderContextOverflow } from "~/modules/providers/server/gateway.ts";
import { hashSourceMessageContent } from "~/modules/memory/server/content-hash.ts";
import { memorySystemPolicy, renderMemoryContext } from "~/modules/memory/server/memory-prompt.ts";
import { prepareMemoryTool } from "~/modules/memory/server/memory-tool.ts";
import { MemoryService } from "~/modules/memory/server/service.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { createSourceIndexer } from "~/modules/tools/server/source-indexer.ts";
import { mergeToolGroups, prepareWebTools } from "~/modules/tools/server/toolset.ts";
import { createUrlAuthority } from "~/modules/tools/server/url-authority.ts";
import { UrlReaderExecutor } from "~/modules/tools/server/url-reader.ts";
import { extractUserMessageUrls } from "~/modules/tools/server/user-urls.ts";
import { WebSearchExecutor } from "~/modules/tools/server/web-search.ts";
import { mergeSource, mergeSources } from "~/modules/tools/sources.ts";
import type { Source, ToolChunkEnvelope } from "~/modules/tools/schema.ts";
import type { CompactionChunkEnvelope } from "../schema.ts";
import {
  calibrationFactor,
  compileActivePrompt,
  estimatePromptTokens,
  latestValidCheckpoint,
  prepareCompactedActiveRounds,
  prepareCompactedHistory,
  shrinkForOverflow,
  type ActiveRound,
  type ActiveRoundCompactionDecision,
  type CompactionDecision,
} from "./compaction.ts";
import { buildHistoryMessages, type PromptDeps } from "./prompt.ts";
import { runtimeContextMessage } from "./runtime-context.ts";
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
  readonly runId?: string;
  readonly seq: number;
  readonly chunkKind: ChunkKind;
  readonly delta: string;
}

export interface DoneEvent {
  readonly messageId: string;
  readonly runId?: string;
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
      researchRunId?: string | undefined;
      timeZone?: string | undefined;
    }): Effect.Effect<void>;
    // Winds a running generation down early, keeping whatever it has already
    // produced. False when this instance is not the one running it — the same
    // single-instance constraint the live chunk tail has (replay is durable,
    // the in-flight fiber is not).
    stopGeneration(messageId: string, expectedRunId?: string): Effect.Effect<boolean>;
    // Chunks already persisted after `afterSeq`, then live chunks, then done.
    // Terminates when the message reaches a terminal status.
    subscribe(
      messageId: string,
      afterSeq: number,
      expectedRunId?: string,
    ): Stream.Stream<StreamEvent>;
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
      const memory = yield* MemoryService;
      const attachments = yield* AttachmentRepo;
      const promptDeps: PromptDeps = {
        attachments,
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
      const inFlight = new Map<
        string,
        { abort: Deferred.Deferred<void>; runId?: string | undefined }
      >();
      const runtimeScope = yield* Effect.scope;
      if (repo.research)
        yield* Effect.forkScoped(
          repo.research.reap().pipe(
            Effect.catchCause((cause) => Effect.logError("research reconciliation failed", cause)),
            Effect.delay(Duration.seconds(10)),
            Effect.forever,
          ),
        );

      const runGeneration = Effect.fn("StreamEngine.runGeneration")(function* (input: {
        userId: string;
        conversationId: string;
        messageId: string;
        modelId: string;
        searchEnabled: boolean;
        researchRunId?: string | undefined;
        timeZone?: string | undefined;
        abort: Deferred.Deferred<void>;
      }) {
        const currentMessage = yield* repo.getMessage(input.messageId);
        if (input.researchRunId && currentMessage?.researchRunId !== input.researchRunId) return;
        const claim =
          currentMessage?.researchRunId && repo.research
            ? yield* repo.research.claim(currentMessage.researchRunId)
            : null;
        if (currentMessage?.generationMode === "research" && !claim) return;
        const research = claim && repo.research ? { ...claim, store: repo.research } : null;
        let researchPhase: ResearchPhase = "error";
        const runtimeContext = runtimeContextMessage(new Date(), input.timeZone);
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
          history
            .filter((m) => m.id !== input.messageId && m.role === "assistant")
            .map((m) => m.id),
        );
        const priorSources = mergeSources(
          priorToolCalls.flatMap((call) => {
            const result = call.result as { sources?: ReadonlyArray<Source> } | null;
            return result?.sources ?? [];
          }),
        );

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
        const writer = yield* Semaphore.make(1);
        const flush = writer.withPermits(1)(
          Effect.uninterruptible(
            Effect.suspend(() => {
              if (buffer.length === 0) return Effect.void;
              const batch = buffer;
              buffer = [];
              const persist = research
                ? research.store.locked(
                    research.fence,
                    (tx) =>
                      tx
                        .insert(messageChunks)
                        .values(batch.map((chunk) => ({ ...chunk, messageId: input.messageId })))
                        .pipe(Effect.orDie, Effect.asVoid),
                    true,
                  )
                : repo.appendChunks(input.messageId, batch);
              return persist.pipe(
                Effect.flatMap(() =>
                  Effect.forEach(
                    batch,
                    (chunk) =>
                      PubSub.publish(pubsub, {
                        kind: "chunk",
                        ...(research ? { runId: research.fence.runId } : {}),
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
          ),
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
            if (research) {
              yield* flush.pipe(Effect.catchCause(() => Effect.void));
              const phase =
                status === "aborted" ? "aborted" : status === "error" ? "error" : researchPhase;
              const finalized = yield* research.store.finalize(
                research.fence.runId,
                phase,
                research.fence.owner,
              );
              if (finalized) {
                const terminal = yield* repo.getMessage(input.messageId);
                const doneStatus =
                  terminal?.status === "streaming" ? "error" : (terminal?.status ?? "error");
                yield* PubSub.publish(pubsub, {
                  kind: "done",
                  messageId: input.messageId,
                  runId: research.fence.runId,
                  status: doneStatus,
                });
                yield* sync.publish(input.userId, {
                  type: "message.status",
                  conversationId: input.conversationId,
                  messageId: input.messageId,
                  status: doneStatus,
                });
              }
              return;
            }
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
          if (research) {
            const work = runResearch({
              store: research.store,
              fence: research.fence,
              gateway,
              repo,
              providers,
              webSearch,
              urlReader,
              promptDeps,
              history: completed,
              priorSources,
              runtimeContext,
              modelId: input.modelId,
              userId: input.userId,
              startedAt: research.run.createdAt.getTime(),
              emit: pushToolChunk,
              emitCompaction: pushCompactionChunk,
              getTextOffset: () => assembled.length,
              text: (delta) =>
                Effect.suspend(() => {
                  pushChunk("text", delta);
                  return flush;
                }),
            });
            const control = Effect.gen(function* () {
              let ticks = 0;
              while (true) {
                yield* Effect.sleep(Duration.seconds(1));
                if (!(yield* research.store.alive(research.fence))) {
                  yield* Deferred.succeed(input.abort, undefined);
                  return yield* Effect.never;
                }
                if (++ticks % 10 === 0) yield* research.store.heartbeat(research.fence);
              }
            });
            researchPhase = yield* Effect.raceFirst(work, control).pipe(
              Effect.timeout(
                Duration.millis(Math.max(1, research.run.deadline.getTime() - Date.now())),
              ),
            );
            return;
          }
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
            ? yield* prepareWebTools({
                webSearch,
                urlReader,
                indexer: createSourceIndexer(priorSources),
                authority,
                requestSearch: input.searchEnabled,
              })
            : undefined;

          // Memory is one stable snapshot for this whole generation. A memory
          // saved during a tool round becomes context on the next user turn, not
          // midway through the answer that created it.
          const memorySettings = yield* memory.getSettings(input.userId);
          const referenceableMemories = memorySettings.effectiveReferenceEnabled
            ? yield* memory.listReferenceable(input.userId)
            : [];
          const renderedMemory = renderMemoryContext(referenceableMemories);
          let sourceUserMessage: (typeof completed)[number] | undefined;
          for (let index = completed.length - 1; index >= 0; index--) {
            const candidate = completed[index];
            if (candidate?.role !== "user") continue;
            sourceUserMessage = candidate;
            break;
          }
          const sourceHasAttachments = sourceUserMessage
            ? (yield* attachments.listForMessages([sourceUserMessage.id])).length > 0
            : false;
          // Attachment-derived content is already present in the first request, so
          // it cannot become trusted durable provenance. Web tools may coexist with
          // memory initially because their output has not entered the transcript
          // yet; once either web tool runs, later rounds remove save_memory.
          const memoryTools =
            model?.capabilities.tools &&
            memorySettings.effectiveAutoSaveEnabled &&
            sourceUserMessage &&
            !sourceHasAttachments
              ? prepareMemoryTool({
                  memory,
                  userId: input.userId,
                  conversationId: input.conversationId,
                  sourceMessageId: sourceUserMessage.id,
                  sourceMessageHash: hashSourceMessageContent(sourceUserMessage.content),
                  ordinals: renderedMemory?.ordinals ?? new Map(),
                })
              : undefined;
          const askTools = model?.capabilities.tools ? prepareAskUserTool() : undefined;
          const nonMemoryToolkit = yield* mergeToolGroups([
            ...(webTools ? [webTools.group] : []),
            ...(askTools ? [askTools] : []),
          ]);
          const toolkit = yield* mergeToolGroups([
            ...(askTools ? [askTools] : []),
            ...(webTools ? [webTools.group] : []),
            ...(memoryTools ? [memoryTools.group] : []),
          ]);

          // Select once, before resolving attachments: the checkpoint replaces
          // its covered prefix entirely, including blobs that may no longer exist.
          // Keep `completed` intact for source authority, usage and memory provenance.
          const questionContexts = new Map<string, string>();
          for (const call of priorToolCalls) {
            if (call.toolName !== "ask_user" || call.status !== "complete") continue;
            const questions = readPresentedQuestions(call.result);
            if (questions) questionContexts.set(call.messageId, formatQuestionContext(questions));
          }
          // Keep an immediate clarification with its answer, including on retry.
          // The bound is a user-led turn start, so no orphan assistant is retained.
          let protectedStart: number | undefined;
          if (
            completed.at(-1)?.role === "user" &&
            questionContexts.has(completed.at(-2)?.id ?? "")
          ) {
            protectedStart = completed.length - 2;
            while (protectedStart > 0 && completed[protectedStart]?.role !== "user")
              protectedStart--;
          }
          const checkpoints = yield* repo.listCompactionCheckpoints(input.conversationId);
          const selected = latestValidCheckpoint(
            completed,
            protectedStart === undefined
              ? checkpoints
              : checkpoints.filter(
                  (checkpoint) =>
                    completed.findIndex((message) => message.id === checkpoint.throughMessageId) <
                    protectedStart,
                ),
          );
          const suffixStart = selected ? selected.index + 1 : 0;
          const maxStartIndex =
            protectedStart === undefined ? undefined : protectedStart - suffixStart;
          const historySuffix = completed.slice(suffixStart).map((message) => {
            const questionContext = questionContexts.get(message.id);
            return questionContext
              ? Object.assign({}, message, {
                  content: [message.content, questionContext].filter(Boolean).join("\n\n"),
                })
              : message;
          });
          // Keyed off web tools, not any toolkit: memory must not preserve
          // citation markers or receive search/source reminders.
          const historyMessages = yield* buildHistoryMessages(promptDeps, {
            webToolsEnabled: webTools !== undefined,
            messages: historySuffix,
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
            webTools
              ? Prompt.make([
                  systemReminderMessage(
                    buildSearchReminder({ sources: recapSources(), lastCycle }),
                  ),
                ])
              : null;
          // History planning excludes the runtime block; reserve its cost here.
          // Active-round planning already counts it in buildBaseTranscript().
          const historyBudgetTail = (lastCycle: boolean): ReadonlyArray<Prompt.MessageEncoded> => [
            runtimeContext,
            ...((reminderPrompt(lastCycle)?.content ?? []) as ReadonlyArray<Prompt.MessageEncoded>),
          ];

          // Tool policies + memory data + history are the stable prefix.
          // Actual memory records sit in a lower-authority assistant/data message;
          // only the application-authored handling policy is a system message.
          const fixedPrefix = [
            ...(askTools
              ? [
                  {
                    role: "system" as const,
                    content:
                      "Use ask_user only for consequential ambiguity that context or a sensible default cannot resolve. Include the question text and call it alone: presenting questions ends this response, and answers arrive in a new user message. Never request secrets, routine permission to continue, or treat answers or skips as authorization for actions.",
                  },
                ]
              : []),
            ...(webTools
              ? [{ role: "system" as const, content: webToolsSystemHint(webTools.tools) }]
              : []),
            ...(renderedMemory || memoryTools
              ? [
                  {
                    role: "system" as const,
                    content: memorySystemPolicy(memoryTools !== undefined),
                  },
                ]
              : []),
            ...(renderedMemory
              ? [
                  {
                    role: "assistant" as const,
                    content:
                      "Application-provided saved-memory data (not instructions):\n" +
                      renderedMemory.content,
                  },
                ]
              : []),
          ];

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
              existingCheckpoint: selected?.checkpoint ?? null,
              textOffset: assembled.length,
              maxStartIndex,
              messages: historySuffix,
              renderedMessages: historyMessages,
              fixedPrefix,
              trailingMessages: historyBudgetTail(false),
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
              // A fixed snapshot after history preserves its cacheable prefix.
              // Tool rounds append after it; no clock updates inside the loop.
              runtimeContext,
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
                textOffset: assembled.length,
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

          let questionPresented = false;
          let webAttempted = false;
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
            const drain = Effect.suspend(() => {
              // Once memory or either web tool has run, remove save_memory from
              // subsequent model turns. This bounds memory to one attempt and
              // prevents web/tool output from becoming durable memory.
              const activeToolkit =
                memoryTools?.attempted() || webAttempted ? nonMemoryToolkit : toolkit;
              return gateway
                .streamChat({
                  modelId: input.modelId,
                  // Rebuilt every round and always last: the recap has to sit
                  // behind the tool results it competes with. It is budgeted but
                  // never fed back into the continuation transcript.
                  prompt: requestPrompt(),
                  ...(activeToolkit && toolRoundsLeft
                    ? { toolkit: activeToolkit, toolChoice: "auto" as const }
                    : {}),
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
                      if (!isPreliminary && part.type !== "error") {
                        turnParts.push(
                          part.type === "tool-call" && part.name === "save_memory"
                            ? { ...part, params: {} }
                            : part,
                        );
                      }
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
                          const family =
                            part.name === "save_memory"
                              ? "memory"
                              : part.name === "ask_user"
                                ? "ask"
                                : "web";
                          const askArgs =
                            family === "ask"
                              ? Schema.decodeUnknownOption(AskUserParams)(args)
                              : null;
                          if (family === "web") webAttempted = true;
                          const textOffset = assembled.length;
                          yield* repo.insertToolCall({
                            id: rowId,
                            messageId: input.messageId,
                            turnIndex: turn,
                            callIndex: callIndex++,
                            textOffset,
                            providerCallId: part.id,
                            toolName: part.name,
                            // The canonical memory row is the sole persisted copy
                            // of proposed content. Chat activity stores only that
                            // the tool ran, so deleting memory actually removes it.
                            arguments:
                              family === "memory"
                                ? {}
                                : family === "ask"
                                  ? askArgs && Option.isSome(askArgs)
                                    ? (askArgs.value as unknown as JsonValue)
                                    : {}
                                  : (args as JsonValue),
                          });
                          if (family === "memory" || family === "ask") {
                            yield* pushToolChunk({
                              v: 1,
                              family,
                              phase: "start",
                              callId: rowId,
                              name: part.name,
                              turnIndex: turn,
                              callIndex: callIndex - 1,
                              textOffset,
                            });
                            return;
                          }

                          const targets = Array.isArray(args["queries"])
                            ? args["queries"].map(String)
                            : Array.isArray(args["urls"])
                              ? args["urls"].map(String)
                              : [];
                          yield* pushToolChunk({
                            v: 1,
                            family,
                            phase: "start",
                            callId: rowId,
                            name: part.name,
                            turnIndex: turn,
                            callIndex: callIndex - 1,
                            textOffset,
                            args: { targets },
                          });
                          return;
                        }
                        case "tool-result": {
                          const rowId = callRowIds.get(part.id) ?? uuidv7();
                          if (part.name === "ask_user") {
                            if (isPreliminary) return;
                            const decoded = Schema.decodeUnknownOption(AskUserResult)(part.result);
                            const result: AskUserResult =
                              !part.isFailure && Option.isSome(decoded)
                                ? decoded.value
                                : {
                                    v: 1,
                                    outcome: "rejected",
                                    message: "Questions could not be presented.",
                                  };
                            const ok = result.outcome === "presented";
                            yield* repo.completeToolCall({
                              id: rowId,
                              result: result as unknown as JsonValue,
                              status: ok ? "complete" : "error",
                              ...(ok
                                ? {}
                                : { error: { code: "QuestionRejected", message: result.message } }),
                            });
                            yield* pushToolChunk({
                              v: 1,
                              family: "ask",
                              phase: "result",
                              callId: rowId,
                              name: part.name,
                              result,
                            });
                            if (ok) questionPresented = true;
                            return;
                          }
                          if (part.name === "save_memory") {
                            // Memory handlers have no preliminary progress. Ignore
                            // any malformed preliminary part rather than persisting
                            // a second activity shape for this family.
                            if (isPreliminary) return;
                            const result = part.result as {
                              ok?: boolean;
                              outcome?: "created" | "updated" | "unchanged" | "rejected";
                            } | null;
                            const outcome = result?.outcome ?? "rejected";
                            const ok = !part.isFailure && result?.ok !== false;
                            yield* repo.completeToolCall({
                              id: rowId,
                              result: { outcome },
                              status: ok ? "complete" : "error",
                              ...(ok
                                ? {}
                                : {
                                    error: {
                                      code: "MemoryNotSaved",
                                      message: "memory was not saved",
                                    },
                                  }),
                            });
                            yield* pushToolChunk({
                              v: 1,
                              family: "memory",
                              phase: "result",
                              callId: rowId,
                              name: part.name,
                              ok,
                              outcome,
                              ...(ok ? {} : { error: "memory was not saved" }),
                            });
                            return;
                          }

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
                              sourcesByIndex.set(
                                source.index,
                                mergeSource(sourcesByIndex.get(source.index), source),
                              );
                            }
                          }

                          if (isPreliminary) {
                            // Live progress: hits found / page fetch transitions.
                            yield* pushToolChunk({
                              v: 1,
                              family: "web",
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
                            family: "web",
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
                );
            });

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
                            textOffset: assembled.length,
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
                    const shrunk = shrinkForOverflow({
                      decision: compaction,
                      maxStartIndex,
                      messages: historySuffix,
                      renderedMessages: historyMessages,
                      fixedPrefix: [
                        ...fixedPrefix,
                        ...(activeOnly.content as unknown as ReadonlyArray<Prompt.MessageEncoded>),
                      ],
                      trailingMessages: historyBudgetTail(!toolRoundsLeft),
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

            if (questionPresented || finishReason !== "tool-calls") break;
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
                  textOffset: assembled.length,
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
        const ran = generate.pipe(Effect.scoped, Effect.as(false));

        yield* Effect.raceFirst(Effect.raceFirst(ran, stopped), flusher).pipe(
          Effect.flatMap((wasStopped) => finalize(wasStopped ? "aborted" : "complete")),
          Effect.catchCause((cause) => finalize("error", cause)),
          Effect.onInterrupt(() => (research ? finalize("error") : Effect.void)),
        );
      });

      const startGeneration = Effect.fn("StreamEngine.startGeneration")(function* (input: {
        userId: string;
        conversationId: string;
        messageId: string;
        modelId: string;
        searchEnabled: boolean;
        researchRunId?: string | undefined;
        timeZone?: string | undefined;
      }) {
        const abort = yield* Deferred.make<void>();
        const registration = { abort, runId: input.researchRunId };
        inFlight.set(input.messageId, registration);
        // Detached from the request fiber: survives the HTTP response ending.
        yield* Effect.forkIn(
          runGeneration({ ...input, abort }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                // Identity-checked: a retry reuses the message id, so this run
                // must not evict the registration a newer one just made.
                if (inFlight.get(input.messageId) === registration)
                  inFlight.delete(input.messageId);
              }),
            ),
          ),
          runtimeScope,
        );
      });

      const stopGeneration = (messageId: string, expectedRunId?: string): Effect.Effect<boolean> =>
        Effect.suspend(() => {
          const registration = inFlight.get(messageId);
          if (!registration || registration.runId !== expectedRunId) return Effect.succeed(false);
          return Deferred.succeed(registration.abort, undefined);
        });

      const subscribe = (
        messageId: string,
        afterSeq: number,
        expectedRunId?: string,
      ): Stream.Stream<StreamEvent> =>
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

            if (message.researchRunId) {
              const runId = expectedRunId ?? message.researchRunId;
              let cursor = afterSeq;
              return Stream.fromEffectSchedule(
                Effect.gen(function* () {
                  yield* repo.research?.reap() ?? Effect.void;
                  const snapshot = yield* repo.research!.tail(messageId, cursor);
                  const current = snapshot?.message;
                  if (!current || current.researchRunId !== runId)
                    return [
                      {
                        kind: "done" as const,
                        messageId,
                        runId: current?.researchRunId ?? runId,
                        status: "error" as const,
                      },
                    ];
                  const rows = snapshot?.chunks ?? [];
                  const events: StreamEvent[] = [];
                  for (const chunk of rows) {
                    if (chunk.seq !== cursor + 1) break;
                    cursor = chunk.seq;
                    events.push({
                      kind: "chunk",
                      messageId,
                      runId,
                      seq: chunk.seq,
                      chunkKind: chunk.kind,
                      delta: chunk.delta,
                    });
                  }
                  if (current.status !== "streaming" && (rows.at(-1)?.seq ?? cursor) === cursor)
                    events.push({ kind: "done", messageId, runId, status: current.status });
                  return events;
                }),
                Schedule.spaced(Duration.seconds(1)),
              ).pipe(
                Stream.flatMap((events) => Stream.fromIterable(events)),
                Stream.takeUntil((event) => event.kind === "done"),
              );
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
