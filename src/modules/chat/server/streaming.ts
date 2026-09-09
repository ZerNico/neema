import { SkillReader } from "~/modules/skills/server/reader.ts";
import { prepareSkillTools } from "~/modules/skills/server/tools.ts";
import { SkillToolName, projectSkillToolResult } from "~/modules/skills/tool-schema.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { acceptGeneratedImage } from "./generated-images.ts";
import { GenerationFence, type GenerationIdentity } from "./generation-fence.ts";
import { boundedReplay, replayDetails, type ProviderReplay } from "./provider-replay.ts";
import { responseTurnPrompt } from "~/modules/providers/server/response-prompt.ts";
import { messageChunks } from "~/db/schema/chat.ts";
import { runConversationResearch } from "./conversation-research.ts";
import { prepareConversationContext } from "./conversation-context.ts";
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
import { preparePlanTool } from "~/modules/tools/server/plan-tool.ts";
import { PlanToolResult, renderPlanReminder } from "~/modules/tools/plan-schema.ts";
import { Prompt, Tool, type Response } from "effect/unstable/ai";
import { uuidv7 } from "uuidv7";
import { AnalyticsRepo } from "~/modules/analytics/server/repo.ts";
import { addFinishUsage, emptyUsageTotals, resolveCost } from "~/modules/analytics/server/usage.ts";
import { BlobStore } from "~/modules/attachments/server/blob-store.ts";
import { DocumentParser } from "~/modules/attachments/server/document-parser.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AiGateway, ProviderContextOverflow } from "~/modules/providers/server/gateway.ts";
import { MemoryService } from "~/modules/memory/server/service.ts";
import {
  KNOWLEDGE_SYSTEM_HINT,
  prepareKnowledgeContext,
  type PreparedKnowledgeContext,
} from "~/modules/knowledge/server/context.ts";
import { KnowledgeSearch } from "~/modules/knowledge/server/search.ts";
import { KnowledgeService } from "~/modules/knowledge/server/service.ts";
import { prepareKnowledgeTools } from "~/modules/knowledge/server/tools.ts";
import {
  KNOWLEDGE_TOOL_LIMITS,
  KnowledgeToolName,
  projectKnowledgeToolResult,
} from "~/modules/knowledge/tool-schema.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { createSourceIndexer } from "~/modules/tools/server/source-indexer.ts";
import { mergeToolGroups, prepareWebTools } from "~/modules/tools/server/toolset.ts";
import { createUrlAuthority } from "~/modules/tools/server/url-authority.ts";
import { UrlReaderExecutor } from "~/modules/tools/server/url-reader.ts";
import { extractUserMessageUrls } from "~/modules/tools/server/user-urls.ts";
import { WebSearchExecutor } from "~/modules/tools/server/web-search.ts";
import { isWebSource, sourceTarget, mergeSource, mergeSources } from "~/modules/tools/sources.ts";
import type { Source, ToolChunkEnvelope, WebToolResult } from "~/modules/tools/schema.ts";
import type { CompactionChunkEnvelope } from "../schema.ts";
import {
  calibrationFactor,
  compileActivePrompt,
  computeBudget,
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
/**
 * Knowledge-backed chats list, read and compare documents in batches, which
 * takes more rounds than a web lookup. A ceiling, not a target: the budget of
 * knowledge operations and the tools-off final pass still apply.
 */
const MAX_KNOWLEDGE_TOOL_ROUNDS = 24;

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
      generationId?: string | undefined;
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
      const knowledgeSearch = yield* KnowledgeSearch;
      const knowledgeService = yield* KnowledgeService;
      const skillReader = yield* SkillReader;
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
      const imageAttachments = yield* Effect.serviceOption(AttachmentService);

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
        generationId?: string | undefined;
        timeZone?: string | undefined;
        abort: Deferred.Deferred<void>;
      }) {
        const fence = yield* GenerationFence;
        const currentMessage = yield* repo.getMessage(input.messageId);
        if (fence && currentMessage?.generationId !== fence.generationId) return;
        if (input.researchRunId && currentMessage?.researchRunId !== input.researchRunId) return;
        const claim =
          currentMessage?.researchRunId && repo.research
            ? yield* repo.research.claim(currentMessage.researchRunId)
            : null;
        if (currentMessage?.generationMode === "research" && !claim) return;
        const research = claim && repo.research ? { ...claim, store: repo.research } : null;
        let researchPhase: ResearchPhase = "error";
        // The frozen configuration this answer runs with. Dispatch consumes it
        // read-only: identity is decided at turn time, access is rechecked here.
        const config = yield* repo.getGenerationConfig(input.messageId);
        const runtimeContext = runtimeContextMessage(new Date(), input.timeZone);
        // Snapshot the model row up front: the ledger wants its display name
        // and pricing even if the admin deletes or reprices it mid-generation.
        const model = yield* providers.getModel(input.modelId);
        const history = yield* repo.listMessages(input.conversationId);
        const completed = history.filter(
          (m) =>
            m.id !== input.messageId &&
            (m.status === "complete" ||
              (m.status !== "streaming" && !!m.assistantOutput?.images.length)),
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
        let acceptedImages = 0;
        let replay: ProviderReplay | null = null;
        const imageOutput = !research && model?.capabilities.imageOutput === true;
        let imageCostIncomplete = false;
        let modelCallOpen = false;
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
                        ...(research
                          ? { runId: research.fence.runId }
                          : fence
                            ? { runId: fence.generationId }
                            : {}),
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
              ...resolveCost(
                totals,
                model?.pricing,
                imageOutput && (imageCostIncomplete || modelCallOpen)
                  ? "incomplete-images"
                  : imageOutput
                    ? "images"
                    : "text",
              ),
            });
            yield* repo.updateConversation(input.conversationId, { lastMessageAt: new Date() });
            yield* PubSub.publish(pubsub, {
              kind: "done",
              messageId: input.messageId,
              ...(fence ? { runId: fence.generationId } : {}),
              status,
            });
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
            // Research reads the same frozen configuration; its knowledge
            // session is scoped to `generate` like the ordinary path's.
            const researchKnowledge =
              config.knowledgeMode !== "none"
                ? {
                    session: yield* knowledgeSearch.session({
                      userId: input.userId,
                      collectionIds: config.collectionIds,
                      manifest: config.manifest,
                    }),
                    service: knowledgeService,
                  }
                : null;
            const work = runConversationResearch({
              memory,
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
              config,
              knowledge: researchKnowledge,
              skillReader,
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
            ...priorSources.filter(isWebSource).map((source) => source.url),
          ]);
          const indexer = createSourceIndexer(priorSources);
          // Every chat model takes tools: the gateway polyfills prompt-based
          // calling for models without native support (`hermes-tools.ts`).
          const webTools = yield* prepareWebTools({
            webSearch,
            urlReader,
            indexer,
            authority,
            requestSearch: input.searchEnabled,
          });

          // Knowledge: one authorized session over the saved manifest for the
          // whole generation. Access loss anywhere fails the generation rather
          // than answering from the part that remains. The session is scoped
          // to `generate`, so a stopped answer closes it.
          const knowledgeSession =
            config.knowledgeMode !== "none"
              ? yield* knowledgeSearch.session({
                  userId: input.userId,
                  collectionIds: config.collectionIds,
                  manifest: config.manifest,
                })
              : null;
          // Selected and agent-attached skills are pinned by the attempt; the
          // rest of the reader's library is offered as metadata so the model
          // can find a relevant skill without being told to use it.
          const skillManifest = [
            ...(config.skills ?? []),
            ...(yield* skillReader.catalogue(
              input.userId,
              (config.skills ?? []).map((entry) => entry.skillId),
            )),
          ];
          const skillTools = skillManifest.length
            ? yield* prepareSkillTools({
                userId: input.userId,
                manifest: skillManifest,
                maxRootChars: Math.floor(
                  computeBudget({
                    contextLength: model?.contextLength,
                    webToolsEnabled: !!webTools,
                  }).input * 0.2,
                ),
              }).pipe(Effect.provideService(SkillReader, skillReader))
            : null;
          const askTools = prepareAskUserTool();
          // The checklist is an agent preference. Retry and edit start from a
          // clean list: a completed step is a claim about work this attempt did.
          const planTools = config.planEnabled ? preparePlanTool() : undefined;
          let knowledgeContext: PreparedKnowledgeContext | null = null;
          const knowledgeTools = knowledgeSession
            ? yield* prepareKnowledgeTools({
                userId: input.userId,
                session: knowledgeSession,
                indexer,
              }).pipe(Effect.provideService(KnowledgeService, knowledgeService))
            : null;

          const conversationContext = yield* prepareConversationContext({
            memory,
            userId: input.userId,
            conversationId: input.conversationId,
            history: completed,
          });
          const { memoryTools } = conversationContext;
          const commonGroups = [
            ...(skillTools ? [skillTools.group] : []),
            ...(webTools ? [webTools.group] : []),
            ...(planTools ? [planTools.group] : []),
            ...(askTools ? [askTools] : []),
          ];
          // Reserve retrieval schemas before preparation: a context selection
          // may downgrade once rendered. Execution tools are built afterwards.
          const budgetToolkit = yield* mergeToolGroups([
            ...commonGroups,
            ...(knowledgeTools ? [knowledgeTools.group] : []),
            ...(memoryTools ? [memoryTools.group] : []),
          ]);
          let retrievalEnabled = config.knowledgeMode === "retrieval";

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
            deferAssistantBytes: true,
            webToolsEnabled: webTools !== undefined || knowledgeSession !== null,
            messages: historySuffix,
            modelSupportsFiles: model?.capabilities.files ?? false,
          });
          const historyGroups: Array<ReadonlyArray<Prompt.MessageEncoded>> = [];
          for (let index = 0; index < historySuffix.length; index++) {
            const message = historySuffix[index]!;
            historyGroups.push(
              message.assistantOutput?.images.length || message.providerReplay?.turns.length
                ? yield* buildHistoryMessages(
                    { ...promptDeps, chat: repo },
                    {
                      messages: [message],
                      deferAssistantBytes: true,
                      expandAssistantTurns: true,
                      webToolsEnabled: webTools !== undefined || knowledgeSession !== null,
                      modelSupportsFiles: model?.capabilities.files ?? false,
                      ...(model
                        ? {
                            modelIdentity: {
                              providerId: model.providerId,
                              modelKey: model.modelKey,
                            },
                          }
                        : {}),
                    },
                  )
                : [historyMessages[index]!],
            );
          }
          const sourcesByIndex = new Map(priorSources.map((source) => [source.index, source]));
          const recapSources = () => {
            const sources = [...sourcesByIndex.values()];
            // oxlint-disable-next-line no-array-sort -- fresh array from Map values
            sources.sort((a, b) => a.index - b.index);
            return sources.slice(-MAX_PRIOR_SOURCES);
          };
          const sourceManifest = () =>
            recapSources()
              .map((source) => `[${source.index}] ${source.title} — ${sourceTarget(source)}`)
              .join("\n");
          // The knowledge budget line is per-turn state: it belongs in the
          // trailing reminder, never in the cacheable prefix.
          const knowledgeReminder = () =>
            knowledgeTools && retrievalEnabled
              ? `Knowledge operations remaining: ${knowledgeTools.remaining()} of ${KNOWLEDGE_TOOL_LIMITS.operations}. Only returned excerpts are evidence; disclose unread or unavailable material.`
              : null;
          // The current checklist replaces the previous one here too: the prompt
          // never accumulates old revisions.
          const planReminder = () => {
            const snapshot = planTools?.current();
            return snapshot ? renderPlanReminder(snapshot) : null;
          };
          const reminderPrompt = (lastCycle: boolean) => {
            const sections = [
              webTools ? buildSearchReminder({ sources: recapSources(), lastCycle }) : null,
              knowledgeReminder(),
              planReminder(),
            ].filter(Boolean);
            return sections.length > 0
              ? Prompt.make([systemReminderMessage(sections.join("\n\n"))])
              : null;
          };
          // Everything that sits after retained history, in order. It is the one
          // list the transcript and the compaction budget both read, so a block
          // added here cannot end up in the prompt without being budgeted.
          // Rebuilt per call: loaded skills and the clock change, and being
          // after history keeps the cacheable prefix intact when they do.
          const trailingContext = (): ReadonlyArray<Prompt.MessageEncoded> => [
            ...(knowledgeContext?.messages ?? []),
            ...(skillTools?.messages() ?? []),
            runtimeContext,
          ];
          // Reminders are appended per request rather than stored in the
          // transcript, so only the budget adds them to the tail.
          const historyBudgetTail = (lastCycle: boolean): ReadonlyArray<Prompt.MessageEncoded> => [
            ...trailingContext(),
            ...((reminderPrompt(lastCycle)?.content ?? []) as ReadonlyArray<Prompt.MessageEncoded>),
          ];

          // Tool policies + memory data + history are the stable prefix.
          // Actual memory records sit in a lower-authority assistant/data message;
          // only the application-authored handling policy is a system message.
          const fixedPrefix = [
            ...(knowledgeSession
              ? [{ role: "system" as const, content: KNOWLEDGE_SYSTEM_HINT }]
              : []),
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
            ...conversationContext.messages(),
            // Agent instructions are user-level configuration: they shape the
            // answer but cannot override application policy above them.
            ...(config.resolvedAgent?.instructions.trim()
              ? [
                  {
                    role: "user" as const,
                    content: `<agent-instructions name=${JSON.stringify(config.resolvedAgent.name)}>\n${config.resolvedAgent.instructions}\n</agent-instructions>`,
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
              renderedMessageGroups: historyGroups,
              fixedPrefix,
              trailingMessages: historyBudgetTail(false),
              webToolsEnabled: webTools !== undefined,
              priorUsage,
              onCompaction: (event) => pushCompactionChunk({ v: 1, ...event }),
            },
          );

          // Selected knowledge, decided against the exact rendered prompt: the
          // turn-time mode is a ceiling ("context" may still downgrade to
          // retrieval here), never the other way round. It sits after the
          // retained history and before the runtime block, and is itself part of
          // the protected trailing context — overflow repair drops history
          // turns, not document bodies.
          if (knowledgeSession && config) {
            const toolSchemaTokens = budgetToolkit
              ? estimatePromptTokens([
                  {
                    role: "assistant",
                    content: JSON.stringify(
                      Object.values(budgetToolkit.tools).map((tool) => ({
                        name: tool.name,
                        description: tool.description ?? "",
                        parameters: Tool.getJsonSchema(tool),
                      })),
                    ),
                  },
                ])
              : 0;
            const prepared = yield* prepareKnowledgeContext({
              userId: input.userId,
              session: knowledgeSession,
              indexer,
              mode: config.knowledgeMode === "retrieval" ? "retrieval" : "context",
              budget: computeBudget({
                contextLength: model?.contextLength,
                webToolsEnabled: webTools !== undefined,
              }),
              baseMessages: [
                ...fixedPrefix,
                ...compaction.injectedMessages,
                ...historyMessages.slice(compaction.startIndex),
                ...historyBudgetTail(false),
              ],
              toolSchemaTokens,
              toolResultReserveTokens: knowledgeTools ? KNOWLEDGE_TOOL_LIMITS.resultTokens : 0,
              priorUsage,
            }).pipe(Effect.provideService(KnowledgeService, knowledgeService));
            knowledgeContext = prepared;
            retrievalEnabled = prepared.mode === "retrieval";
            if (prepared.activity) {
              // Direct context registers its sources like a tool would, through
              // an application-authored activity: replay, reload and branch all
              // render these citations from the same durable row.
              const rowId = uuidv7();
              yield* repo.insertToolCall({
                id: rowId,
                messageId: input.messageId,
                turnIndex: 0,
                callIndex: 0,
                textOffset: 0,
                providerCallId: `knowledge-context:${rowId}`,
                toolName: "knowledge_context",
                arguments: {},
              });
              yield* pushToolChunk({
                v: 1,
                family: "knowledge",
                phase: "start",
                callId: rowId,
                name: "knowledge_context",
                turnIndex: 0,
                callIndex: 0,
                textOffset: 0,
              });
              for (const source of prepared.activity.sources)
                sourcesByIndex.set(
                  source.index,
                  mergeSource(sourcesByIndex.get(source.index), source),
                );
              yield* repo.completeToolCall({
                id: rowId,
                result: prepared.activity as unknown as JsonValue,
                status: "complete",
              });
              yield* pushToolChunk({
                v: 1,
                phase: "result",
                callId: rowId,
                name: "knowledge_context",
                ...prepared.activity,
              });
            }
          }
          for (const [index, entry] of (config.skills ?? [])
            .filter((entry) => entry.explicit)
            .entries()) {
            const rowId = uuidv7();
            const activity = {
              family: "skill" as const,
              version: 1 as const,
              name: "load_skill" as const,
              skillId: entry.skillId,
              skillName: entry.name,
              path: "SKILL.md",
              status: "complete" as const,
            };
            yield* repo.insertToolCall({
              id: rowId,
              messageId: input.messageId,
              turnIndex: 0,
              callIndex: -5 + index,
              textOffset: 0,
              providerCallId: `skill-context:${rowId}`,
              toolName: "load_skill",
              arguments: {},
            });
            yield* pushToolChunk({
              v: 1,
              family: "skill",
              phase: "start",
              callId: rowId,
              name: "load_skill",
              turnIndex: 0,
              callIndex: -5 + index,
              textOffset: 0,
              skillId: entry.skillId,
              skillName: entry.name,
              path: "SKILL.md",
            });
            yield* repo.completeToolCall({ id: rowId, result: activity, status: "complete" });
            yield* pushToolChunk({ v: 1, phase: "result", callId: rowId, ...activity });
          }
          const executionGroups = [
            ...commonGroups,
            ...(retrievalEnabled && knowledgeTools ? [knowledgeTools.group] : []),
          ];
          const nonMemoryToolkit = yield* mergeToolGroups(executionGroups);
          const toolkit = memoryTools
            ? yield* mergeToolGroups([...executionGroups, memoryTools.group])
            : nonMemoryToolkit;
          const maxToolRounds = retrievalEnabled ? MAX_KNOWLEDGE_TOOL_ROUNDS : MAX_TOOL_ROUNDS;

          // Direct context reserves the first call slot; model calls start after.
          const firstCallIndex = knowledgeContext?.activity ? 1 : 0;

          // Hydrate only the retained suffix after compaction. Subsequent overflow
          // repair can drop these whole units, never resurrect earlier image bytes.
          const retainedHistory = new Map<number, ReadonlyArray<Prompt.MessageEncoded>>();
          const loadedBytes = new Map<string, Uint8Array>();
          for (let index = compaction.startIndex; index < historySuffix.length; index++) {
            const message = historySuffix[index]!;
            retainedHistory.set(
              index,
              message.assistantOutput?.images.length || message.providerReplay?.turns.length
                ? yield* buildHistoryMessages(
                    { ...promptDeps, chat: repo },
                    {
                      messages: [message],
                      loadedBytes,
                      webToolsEnabled: webTools !== undefined || knowledgeSession !== null,
                      modelSupportsFiles: model?.capabilities.files ?? false,
                      modelSupportsVision: model?.capabilities.vision ?? false,
                      ...(model
                        ? {
                            modelIdentity: {
                              providerId: model.providerId,
                              modelKey: model.modelKey,
                            },
                          }
                        : {}),
                      expandAssistantTurns: true,
                    },
                  )
                : [historyMessages[index]!],
            );
          }
          const buildBaseTranscript = () =>
            Prompt.make([
              ...fixedPrefix,
              ...compaction.injectedMessages,
              ...historyMessages
                .slice(compaction.startIndex)
                .flatMap(
                  (message, index) =>
                    retainedHistory.get(index + compaction.startIndex) ?? [message],
                ),
              ...trailingContext(),
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
          for (let turn = 0; turn <= maxToolRounds; turn++) {
            if (skillTools) yield* skillTools.authorize();
            if (knowledgeTools) yield* knowledgeTools.authorize();
            else if (knowledgeSession) yield* knowledgeSession.authorize();
            const toolRoundsLeft = turn < maxToolRounds;
            let finishReason: Response.FinishReason | undefined;
            let callIndex = turn === 0 ? firstCallIndex : 0;
            const turnParts: Response.AnyPart[] = [];
            const turnStartOffset = assembled.length;
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
              // A generation gets one memory save attempt across all tool rounds.
              const activeToolkit = memoryTools?.attempted() ? nonMemoryToolkit : toolkit;
              modelCallOpen = true;
              return gateway
                .streamChat({
                  imageOutput,
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
                          part.type === "tool-call" &&
                            (part.name === "save_memory" || part.name === "update_plan")
                            ? { ...part, params: {} }
                            : part.type === "tool-result" && part.name === "update_plan"
                              ? {
                                  ...part,
                                  encodedResult:
                                    (part.result as PlanToolResult).outcome === "updated"
                                      ? {
                                          outcome: "updated",
                                          message:
                                            "The current checklist is in the trailing reminder.",
                                        }
                                      : part.encodedResult,
                                }
                              : part,
                        );
                      }
                      switch (part.type) {
                        case "file": {
                          if (!imageOutput || !fence || Option.isNone(imageAttachments))
                            return yield* Effect.die(
                              new Error("Image output is unavailable for this call."),
                            );
                          yield* flush;
                          const image = yield* writer.withPermits(1)(
                            acceptGeneratedImage(imageAttachments.value, {
                              fence,
                              mediaType: part.mediaType,
                              data: part.data,
                              textOffset: assembled.length,
                              turnIndex: turn,
                              callIndex,
                              eventIndex: seq + 1,
                              seq: seq + 1,
                            }).pipe(
                              Effect.flatMap((image) =>
                                Effect.gen(function* () {
                                  seq += 1;
                                  yield* PubSub.publish(pubsub, {
                                    kind: "chunk",
                                    messageId: input.messageId,
                                    runId: fence.generationId,
                                    seq,
                                    chunkKind: "image",
                                    delta: JSON.stringify(image),
                                  });
                                  return image;
                                }),
                              ),
                              Effect.uninterruptible,
                            ),
                          );
                          void image;
                          acceptedImages += 1;
                          return;
                        }
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
                          const args = part.params as Record<string, unknown>;
                          const family =
                            part.name === "save_memory"
                              ? "memory"
                              : part.name === "ask_user"
                                ? "ask"
                                : part.name === "update_plan"
                                  ? "plan"
                                  : Schema.is(SkillToolName)(part.name)
                                    ? "skill"
                                    : Schema.is(KnowledgeToolName)(part.name)
                                      ? "knowledge"
                                      : part.name === "web_search" || part.name === "read_url"
                                        ? "web"
                                        : null;
                          if (!family) return;
                          const rowId = uuidv7();
                          callRowIds.set(part.id, rowId);
                          const askArgs =
                            family === "ask"
                              ? Schema.decodeUnknownOption(AskUserParams)(args)
                              : null;
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
                              family === "memory" || family === "skill"
                                ? {}
                                : family === "ask"
                                  ? askArgs && Option.isSome(askArgs)
                                    ? (askArgs.value as unknown as JsonValue)
                                    : {}
                                  : (args as JsonValue),
                          });
                          if (family === "memory" || family === "ask" || family === "plan") {
                            yield* pushToolChunk(
                              family === "plan"
                                ? {
                                    v: 1,
                                    family,
                                    phase: "start",
                                    callId: rowId,
                                    name: "update_plan",
                                    turnIndex: turn,
                                    callIndex: callIndex - 1,
                                    textOffset,
                                  }
                                : {
                                    v: 1,
                                    family,
                                    phase: "start",
                                    callId: rowId,
                                    name: part.name,
                                    turnIndex: turn,
                                    callIndex: callIndex - 1,
                                    textOffset,
                                  },
                            );
                            return;
                          }
                          if (family === "skill") {
                            const entry = config.skills?.find(
                              (entry) => entry.skillId === args["skillId"],
                            );
                            yield* pushToolChunk({
                              v: 1,
                              family: "skill",
                              phase: "start",
                              callId: rowId,
                              name: part.name as typeof SkillToolName.Type,
                              turnIndex: turn,
                              callIndex: callIndex - 1,
                              textOffset,
                              skillId: entry?.skillId ?? "",
                              skillName: entry?.name ?? "Skill",
                              path:
                                part.name === "load_skill"
                                  ? "SKILL.md"
                                  : typeof args["path"] === "string"
                                    ? args["path"].slice(0, 240)
                                    : "",
                            });
                            return;
                          }
                          if (family === "knowledge") {
                            const queries = Array.isArray(args["queries"])
                              ? args["queries"].map(String)
                              : [];
                            yield* pushToolChunk({
                              v: 1,
                              family,
                              phase: "start",
                              callId: rowId,
                              name: part.name as typeof KnowledgeToolName.Type,
                              turnIndex: turn,
                              callIndex: callIndex - 1,
                              textOffset,
                              ...(queries.length > 0 ? { targets: queries } : {}),
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
                          const rowId = callRowIds.get(part.id);
                          if (!rowId) return;
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
                          if (part.name === "update_plan") {
                            if (isPreliminary) return;
                            const decoded = Schema.decodeUnknownOption(PlanToolResult)(part.result);
                            const result: PlanToolResult =
                              !part.isFailure && Option.isSome(decoded)
                                ? decoded.value
                                : {
                                    v: 1,
                                    outcome: "rejected",
                                    message: "The checklist could not be updated.",
                                  };
                            const ok = result.outcome === "updated";
                            // Durable activity retains this accepted revision; only
                            // the model continuation compacts old lists.
                            yield* repo.completeToolCall({
                              id: rowId,
                              result: result as unknown as JsonValue,
                              status: ok ? "complete" : "error",
                              ...(ok
                                ? {}
                                : { error: { code: "PlanRejected", message: result.message } }),
                            });
                            yield* pushToolChunk({
                              v: 1,
                              family: "plan",
                              phase: "result",
                              callId: rowId,
                              name: "update_plan",
                              ok,
                              ...(ok ? { steps: result.steps } : { error: result.message }),
                            });
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

                          if (Schema.is(SkillToolName)(part.name)) {
                            if (isPreliminary) return;
                            const activity = projectSkillToolResult(part.name, part.result) ?? {
                              family: "skill" as const,
                              version: 1 as const,
                              name: part.name,
                              skillId: "",
                              skillName: "Skill",
                              path: "",
                              status: "error" as const,
                              error: "Skill tool failed.",
                            };
                            yield* repo.completeToolCall({
                              id: rowId,
                              result: activity as unknown as JsonValue,
                              status: activity.status === "complete" ? "complete" : "error",
                            });
                            yield* pushToolChunk({
                              v: 1,
                              phase: "result",
                              callId: rowId,
                              ...activity,
                            });
                            return;
                          }
                          if (Schema.is(KnowledgeToolName)(part.name)) {
                            if (isPreliminary) return;
                            const activity = projectKnowledgeToolResult(
                              part.result,
                              part.isFailure,
                              knowledgeTools?.remaining() ?? 0,
                            );
                            for (const source of activity.sources)
                              sourcesByIndex.set(
                                source.index,
                                mergeSource(sourcesByIndex.get(source.index), source),
                              );
                            yield* repo.completeToolCall({
                              id: rowId,
                              result: activity as unknown as JsonValue,
                              status: activity.ok ? "complete" : "error",
                              ...(activity.ok
                                ? {}
                                : {
                                    error: {
                                      code: "ToolFailed",
                                      message: activity.error ?? "knowledge tool failed",
                                    },
                                  }),
                            });
                            yield* pushToolChunk({
                              v: 1,
                              phase: "result",
                              callId: rowId,
                              name: part.name,
                              ...activity,
                            });
                            return;
                          }

                          const result = part.result as Partial<WebToolResult> | null;
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
                          modelCallOpen = false;
                          if (imageOutput) {
                            if (part.metadata.openrouter?.usage?.cost == null)
                              imageCostIncomplete = true;
                            if (model) {
                              const details = replayDetails(
                                part.metadata.openrouter?.reasoningDetails ?? [],
                              );
                              replay = boundedReplay({
                                v: 1,
                                providerId: model.providerId,
                                modelKey: model.modelKey,
                                turns: [
                                  ...(replay?.turns ?? []),
                                  {
                                    turnIndex: turn,
                                    startOffset: turnStartOffset,
                                    endOffset: assembled.length,
                                    reasoningDetails: details,
                                  },
                                ],
                              });
                              yield* repo.saveProviderReplay(input.messageId, replay);
                            }
                          }
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
                      renderedMessageGroups: historyGroups,
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
            if (skillTools) yield* skillTools.authorize();
            if (knowledgeTools) yield* knowledgeTools.authorize();
            else if (knowledgeSession) yield* knowledgeSession.authorize();

            // Validate after draining so reported usage and partial output survive failure.
            if (
              finishReason === undefined ||
              finishReason === "unknown" ||
              finishReason === "other"
            )
              return yield* Effect.fail(new Error("[ResponseIncomplete]"));
            if (finishReason === "content-filter")
              return yield* Effect.fail(new Error("[ResponseFiltered]"));
            if (finishReason === "error") return yield* Effect.fail(new Error("[ResponseError]"));
            if (questionPresented || finishReason !== "tool-calls") break;
            // A completed response/tool batch is one atomic unit. It becomes
            // eligible for compaction only now, after every tool result is
            // terminal; no call can ever be separated from its result.
            activeRounds = [
              ...activeRounds,
              {
                turnIndex: turn,
                prompt: imageOutput
                  ? responseTurnPrompt(turnParts)
                  : Prompt.fromResponseParts(turnParts),
              },
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
              const trailing = reminderPrompt(turn + 1 >= maxToolRounds);
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
          // Internal tool rounds need no prose. A validated question is itself the
          // answer; research returns through its own runner before this chat loop.
          if (!questionPresented && assembled.trim().length === 0 && acceptedImages === 0)
            return yield* Effect.fail(new Error("[ResponseEmpty]"));
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
        generationId?: string | undefined;
        timeZone?: string | undefined;
      }) {
        const abort = yield* Deferred.make<void>();
        const message = yield* repo.getMessage(input.messageId);
        if (
          !input.researchRunId &&
          (!input.generationId || message?.generationId !== input.generationId)
        )
          return;
        const fence: GenerationIdentity | null =
          !input.researchRunId && input.generationId
            ? {
                userId: input.userId,
                conversationId: input.conversationId,
                messageId: input.messageId,
                generationId: input.generationId,
              }
            : null;
        const registration = { abort, runId: input.researchRunId ?? fence?.generationId };
        inFlight.set(input.messageId, registration);
        // Detached from the request fiber: survives the HTTP response ending.
        yield* Effect.forkIn(
          runGeneration({ ...input, abort }).pipe(
            Effect.provideService(GenerationFence, fence),
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

            const snapshot = repo.research ? yield* repo.research.tail(messageId, afterSeq) : null;
            const current = snapshot?.message ?? message;
            const runId = expectedRunId ?? current.generationId ?? undefined;
            if (current.generationId && current.generationId !== runId)
              return Stream.make({
                kind: "done" as const,
                messageId,
                runId: current.generationId,
                status: "error" as const,
              });
            const persisted = snapshot?.chunks ?? (yield* repo.chunksAfter(messageId, afterSeq));
            let lastSeq = persisted.at(-1)?.seq ?? afterSeq;

            const replay: Stream.Stream<StreamEvent> = Stream.fromIterable(
              persisted.map((c) => ({
                kind: "chunk" as const,
                ...(runId ? { runId } : {}),
                messageId,
                seq: c.seq,
                chunkKind: c.kind,
                delta: c.delta,
              })),
            );

            if (current.status !== "streaming") {
              const done: StreamEvent = {
                kind: "done",
                messageId,
                ...(runId ? { runId } : {}),
                status: current.status,
              };
              return replay.pipe(Stream.concat(Stream.make(done)));
            }

            const live: Stream.Stream<StreamEvent> = Stream.fromSubscription(subscription).pipe(
              Stream.filter((event) => event.messageId === messageId && event.runId === runId),
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
  ).pipe(Layer.provideMerge(SkillReader.layer));
}
