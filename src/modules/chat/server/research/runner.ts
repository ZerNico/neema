import { eq } from "drizzle-orm";
import { Cause, Duration, Effect, Option, Schema, Semaphore, Stream } from "effect";
import { Prompt, Response, Tool, Toolkit } from "effect/unstable/ai";
import { uuidv7 } from "uuidv7";
import {
  conversationCompactionCheckpoints,
  messageCompactionEvents,
  messageToolCalls,
  researchCalls,
  researchRuns,
  researchTasks,
  usageEvents,
} from "~/db/schema/index.ts";
import type { JsonValue } from "~/db/schema/providers.ts";
import { addFinishUsage, emptyUsageTotals, resolveCost } from "~/modules/analytics/server/usage.ts";
import { ProviderUnreachable, type AiGateway } from "~/modules/providers/server/gateway.ts";
import type { ProviderRepo } from "~/modules/providers/server/repo.ts";
import {
  AskUserResult,
  formatQuestionContext,
  readPresentedQuestions,
} from "~/modules/tools/ask-user-schema.ts";
import type { Source, ToolChunkEnvelope, WebToolResult } from "~/modules/tools/schema.ts";
import { prepareAskUserTool } from "~/modules/tools/server/ask-user.ts";
import { createSourceIndexer } from "~/modules/tools/server/source-indexer.ts";
import { KNOWLEDGE_SYSTEM_HINT } from "~/modules/knowledge/server/context.ts";
import type { KnowledgeSearchSession } from "~/modules/knowledge/server/search.ts";
import { KnowledgeService } from "~/modules/knowledge/server/service.ts";
import { prepareKnowledgeTools } from "~/modules/knowledge/server/tools.ts";
import {
  KNOWLEDGE_TOOL_LIMITS,
  KnowledgeToolName,
  projectKnowledgeToolResult,
} from "~/modules/knowledge/tool-schema.ts";
import type { GenerationConfig } from "../repo.ts";
import { isWebSource, mergeSource, mergeSources } from "~/modules/tools/sources.ts";
import { createUrlAuthority } from "~/modules/tools/server/url-authority.ts";
import { extractUserMessageUrls } from "~/modules/tools/server/user-urls.ts";
import { mergeToolGroups, prepareWebTools } from "~/modules/tools/server/toolset.ts";
import type { WebSearchExecutor } from "~/modules/tools/server/web-search.ts";
import type { UrlReaderExecutor } from "~/modules/tools/server/url-reader.ts";
import type { CompactionChunkEnvelope } from "../../schema.ts";
import {
  projectResearchProgress,
  type ResearchProgress,
  type ResearchTaskProgress,
} from "../../research-schema.ts";
import {
  COMPACTION_CONFIG,
  compileActivePrompt,
  computeBudget,
  estimatePromptTokens,
  latestValidCheckpoint,
  prepareCompactedActiveRounds,
  prepareCompactedHistory,
  shrinkForOverflow,
  type ActiveRound,
  type ActiveRoundCompactionDecision,
  type CompactionDeps,
  type CompactionDecision,
} from "../compaction.ts";
import { buildHistoryMessages, type PromptDeps } from "../prompt.ts";
import type { ChatRepo, MessageRow } from "../repo.ts";
import {
  ResearchBudget,
  RESEARCH_LIMITS,
  researchOutputCaps,
  researchPhaseSpecs,
  type ResearchCallSpec,
  type ResearchCallPhase,
  validateResearchCitations,
} from "./budget.ts";
import { initialResearchProgress, type ResearchFence, type ResearchStore } from "./repo.ts";
import * as prompts from "./prompts.ts";
import {
  boundEvidence,
  boundedSourceManifest,
  evidenceManifest,
  evidencePrompt,
  evidenceTokens,
  type EvidenceBlock,
} from "./evidence.ts";

const DispatchParams = Schema.Struct({
  tasks: Schema.Array(
    Schema.Struct({
      title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
      assignment: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8000)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(3)),
});
const dispatchTool = Tool.make("dispatch_research", {
  description: "Dispatch a bounded batch of isolated research assignments.",
  parameters: DispatchParams,
  success: Schema.Struct({ accepted: Schema.Int }),
  failureMode: "return",
});
const finishTool = Tool.make("finish_research", {
  description: "Finish investigation and synthesize the available reports.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({ ok: Schema.Boolean }),
  failureMode: "return",
});
export const ResearchCoordinatorTools = Toolkit.make(dispatchTool, finishTool);
const json = (value: unknown) => value as JsonValue;

class ResearchExecutionError extends Schema.TaggedError<ResearchExecutionError>()(
  "ResearchExecutionError",
  { reason: Schema.Literals(["context", "budget", "provider_timeout"]) },
) {}

// Only fixed application-owned diagnostics leave this boundary. Provider errors
// can contain request bodies, credentials or fetched content; never display them.
const researchFailureMessage = (cause: Cause.Cause<unknown>): string => {
  for (const reason of cause.reasons) {
    const error =
      reason._tag === "Fail" ? reason.error : reason._tag === "Die" ? reason.defect : undefined;
    if (Cause.isTimeoutError(error))
      return "Exploration reached its time limit. Some coverage is missing.";
    if (error instanceof ResearchExecutionError) {
      if (error.reason === "budget")
        return "Research reached its model-call or output-token budget. Some coverage is missing.";
      if (error.reason === "provider_timeout")
        return "A research provider request timed out. Some coverage is missing.";
      return "Protected research context does not fit the selected model. Some coverage is missing.";
    }
    const tag =
      typeof error === "object" && error !== null && "_tag" in error ? error._tag : undefined;
    if (tag === "ProviderContextOverflow")
      return "The provider rejected the research context size. Some coverage is missing.";
    if (tag === "ProviderUnreachable") {
      const diagnostic = error instanceof ProviderUnreachable ? error.diagnostic : undefined;
      const detail = diagnostic
        ? ` (${diagnostic.kind}${diagnostic.status === undefined ? "" : `; HTTP ${diagnostic.status}`}${diagnostic.code === undefined ? "" : `; provider code ${diagnostic.code}`})`
        : "";
      return `A research provider request failed${detail}. Some coverage is missing.`;
    }
    if (tag === "ModelNotFound")
      return "The selected research model is no longer available. Some coverage is missing.";
  }
  return "Research stopped because of an execution failure. Some coverage is missing.";
};

export const runResearch = Effect.fn("research.run")(function* (deps: {
  store: ResearchStore;
  fence: ResearchFence;
  gateway: AiGateway["Service"];
  repo: ChatRepo["Service"];
  providers: ProviderRepo["Service"];
  webSearch: WebSearchExecutor["Service"];
  urlReader: UrlReaderExecutor["Service"];
  promptDeps: PromptDeps;
  history: ReadonlyArray<MessageRow>;
  priorSources: ReadonlyArray<Source>;
  runtimeContext: Prompt.MessageEncoded;
  /** The frozen configuration of this generation. */
  config: GenerationConfig;
  /** Open when the configuration selects knowledge; shared by every worker. */
  knowledge: {
    session: KnowledgeSearchSession;
    service: KnowledgeService["Service"];
  } | null;
  modelId: string;
  userId: string;
  startedAt: number;
  emit: (event: ToolChunkEnvelope) => Effect.Effect<void>;
  emitCompaction: (event: CompactionChunkEnvelope) => Effect.Effect<void>;
  text: (delta: string) => Effect.Effect<void>;
  getTextOffset: () => number;
}) {
  const { store, fence } = deps;
  const model = yield* deps.providers.getModel(deps.modelId);
  const caps = researchOutputCaps(model?.contextLength);
  const specs = researchPhaseSpecs(caps, COMPACTION_CONFIG.summaryMaxOutputTokens);
  const maxSearches = yield* deps.webSearch.researchSearchLimit();
  const budget = new ResearchBudget(deps.startedAt, Date.now, caps, maxSearches);
  const external = yield* Semaphore.make(RESEARCH_LIMITS.externalOps);
  const progressWriter = yield* Semaphore.make(1);
  const sources = new Map<number, Source>();
  const registeredSources = () => mergeSources([...deps.priorSources, ...sources.values()]);
  const citationIds = () => new Set(registeredSources().map((source) => source.index));
  let progress = initialResearchProgress(fence.runId);
  const limitations = new Set<string>();
  const tasks: Array<
    { -readonly [K in keyof ResearchTaskProgress]: ResearchTaskProgress[K] } & { report?: string }
  > = [];
  const taskSources = new Map<string, Map<number, Source>>();
  const manifest = (taskId: string, spec: ResearchCallSpec) =>
    boundedSourceManifest(
      [...(taskSources.get(taskId)?.values() ?? [])],
      Math.floor(
        computeBudget({
          contextLength: model?.contextLength,
          webToolsEnabled: true,
          outputReserve: spec.maxOutputTokens,
        }).input / 8,
      ),
    );
  let lastSnapshot = "";
  // Serialize snapshot creation through persistence and publication, not just seq assignment.
  const update = (phase: ResearchProgress["phase"] = progress.phase) =>
    progressWriter.withPermits(1)(
      Effect.gen(function* () {
        progress = projectResearchProgress({
          ...progress,
          phase,
          tasks,
          limitations: [...limitations],
        });
        const snapshot = progress;
        const encoded = JSON.stringify({ progress: snapshot, sources: [...sources.values()] });
        if (encoded === lastSnapshot) return;
        yield* store.locked(fence, (tx) =>
          Effect.gen(function* () {
            yield* tx
              .update(researchRuns)
              .set({ progress: snapshot })
              .where(eq(researchRuns.id, fence.runId))
              .pipe(Effect.orDie);
            yield* tx
              .update(messageToolCalls)
              .set({
                result: json({
                  progress: snapshot,
                  sources: [...sources.values()],
                  targets: [],
                  resultCount: sources.size,
                }),
              })
              .where(eq(messageToolCalls.id, fence.runId))
              .pipe(Effect.orDie);
          }),
        );
        yield* deps.emit({
          v: 1,
          family: "research",
          name: "deep_research",
          callId: fence.runId,
          runId: fence.runId,
          phase: "progress",
          turnIndex: 0,
          callIndex: 0,
          textOffset: 0,
          progress: snapshot,
        });
        lastSnapshot = encoded;
      }),
    );
  yield* store.locked(fence, (tx) =>
    Effect.gen(function* () {
      yield* tx
        .update(researchRuns)
        .set({ modelName: model?.displayName ?? deps.modelId, pricing: model?.pricing ?? null })
        .where(eq(researchRuns.id, fence.runId))
        .pipe(Effect.orDie);
      yield* tx
        .insert(messageToolCalls)
        .values({
          id: fence.runId,
          messageId: fence.messageId,
          researchRunId: fence.runId,
          turnIndex: 0,
          callIndex: 0,
          textOffset: 0,
          providerCallId: fence.runId,
          toolName: "deep_research",
          arguments: {},
          result: json({ progress, sources: [] }),
          status: "running",
        })
        .pipe(Effect.orDie);
    }),
  );
  yield* update();
  const indexer = createSourceIndexer(deps.priorSources);
  const web = yield* prepareWebTools({
    webSearch: deps.webSearch,
    urlReader: deps.urlReader,
    indexer,
    authority: createUrlAuthority([
      ...extractUserMessageUrls(deps.history),
      ...deps.priorSources.filter(isWebSource).map((source) => source.url),
    ]),
    requestSearch: true,
    policy: {
      admit: (kind, count) => budget.admitWeb(kind, count),
      run: (effect) => external.withPermits(1)(effect),
      observeSearch: (ok) => budget.observeSearch(ok),
    },
  });
  if (!web?.tools.search || !web.tools.reader)
    return yield* Effect.die(new Error("Deep research requires enabled search and reader tools."));
  // Knowledge tools share one budget, permit pool and citation sequence across
  // every worker; they are separate from the web allowance on purpose.
  const knowledgeTools = deps.knowledge
    ? yield* prepareKnowledgeTools({
        userId: deps.userId,
        session: deps.knowledge.session,
        indexer,
      }).pipe(Effect.provideService(KnowledgeService, deps.knowledge.service))
    : null;
  const workerToolkit = yield* mergeToolGroups([
    web.group,
    ...(knowledgeTools ? [knowledgeTools.group] : []),
  ]);
  let compactionPosition = 0;

  const invoke = Effect.fn("research.invoke")(function* (input: {
    spec: ResearchCallSpec;
    prompt: Prompt.Prompt;
    toolkit?: Toolkit.WithHandler<any> | undefined;
    taskId?: string;
  }) {
    if (!(yield* store.alive(fence)))
      return yield* Effect.die(new Error("Research cancelled or ownership lost"));
    if (knowledgeTools) yield* knowledgeTools.authorize();
    const { phase, maxOutputTokens: cap } = input.spec;
    if (
      estimatePromptTokens(input.prompt.content as ReadonlyArray<Prompt.MessageEncoded>) >
      computeBudget({
        contextLength: model?.contextLength,
        outputReserve: cap,
        webToolsEnabled: !!input.toolkit,
      }).input
    )
      return yield* new ResearchExecutionError({ reason: "context" });
    const reservation = budget.reserve(input.spec);
    if (!reservation) return yield* new ResearchExecutionError({ reason: "budget" });
    const id = uuidv7();
    yield* store.locked(fence, (tx) =>
      tx
        .insert(researchCalls)
        .values({
          id,
          runId: fence.runId,
          taskId: input.taskId ?? null,
          ordinal: reservation.ordinal,
          phase,
          reservedOutputTokens: reservation.maxOutputTokens,
        })
        .pipe(Effect.orDie, Effect.asVoid),
    );
    const totals = emptyUsageTotals();
    let usage = new Response.Usage({
      inputTokens: {
        total: undefined,
        uncached: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    });
    let metadata: unknown;
    let text = "";
    let synthesisLine = "";
    let finishReason: string | undefined;
    let presented = false;
    const parts: Response.AnyPart[] = [];
    const rows = new Map<string, string>();
    let callIndex = 0;
    const stream = deps.gateway.streamChat({
      modelId: deps.modelId,
      prompt: input.prompt,
      ...(input.toolkit ? { toolkit: input.toolkit } : {}),
      maxOutputTokens: cap,
    });
    yield* stream.pipe(
      // Inactivity, not elapsed time: a worker's searches and page reads run
      // inside this stream and each emit progress, so a wall-clock cap would
      // fail a task that is working rather than one whose provider stalled.
      Stream.timeoutOrElse({
        duration: Duration.millis(RESEARCH_LIMITS.providerStallMs),
        orElse: () => Stream.fail(new ResearchExecutionError({ reason: "provider_timeout" })),
      }),
      Stream.runForEach((part) =>
        Effect.gen(function* () {
          const preliminary =
            part.type === "tool-result" && (part as { preliminary?: boolean }).preliminary === true;
          if (part.type === "finish") {
            finishReason = part.reason;
            usage = part.usage;
            metadata = part.metadata;
            addFinishUsage(totals, part);
            const complete =
              part.usage.inputTokens.total !== undefined &&
              part.usage.outputTokens.total !== undefined;
            // A finish already observed must survive Stop. Fence still requires the same live owner;
            // cancellation is allowed only for this bounded accounting checkpoint.
            yield* Effect.uninterruptible(
              store
                .locked(
                  fence,
                  (tx) =>
                    Effect.gen(function* () {
                      yield* tx
                        .update(researchCalls)
                        .set({ usage: totals, usageComplete: complete, status: "complete" })
                        .where(eq(researchCalls.id, id))
                        .pipe(Effect.orDie);
                      if (phase === "compaction")
                        yield* tx
                          .insert(usageEvents)
                          .values({
                            id,
                            userId: deps.userId,
                            kind: "compaction",
                            modelId: model?.id ?? null,
                            modelName: model?.displayName ?? deps.modelId,
                            conversationId: fence.conversationId,
                            messageId: fence.messageId,
                            status: "complete",
                            inputTokens: totals.inputTokens,
                            outputTokens: totals.outputTokens,
                            cachedInputTokens: totals.cachedInputTokens,
                            reasoningTokens: totals.reasoningTokens,
                            usageComplete: complete,
                            ...(complete
                              ? resolveCost(totals, model?.pricing)
                              : { cost: null, costSource: null }),
                          })
                          .onConflictDoNothing()
                          .pipe(Effect.orDie);
                    }),
                  true,
                )
                .pipe(Effect.timeout(Duration.seconds(5))),
            );
            budget.finish(reservation, complete ? part.usage.outputTokens.total : undefined);
          }
          if (!preliminary && part.type !== "error") parts.push(part);
          if (part.type === "text-delta") {
            text += part.delta;
            if (phase === "synthesis") {
              synthesisLine += part.delta;
              const newline = synthesisLine.lastIndexOf("\n");
              if (newline >= 0) {
                const checked = validateResearchCitations(
                  synthesisLine.slice(0, newline + 1),
                  citationIds(),
                );
                if (checked.invalid)
                  limitations.add("Unregistered final citation references were removed.");
                yield* deps.text(checked.text);
                synthesisLine = synthesisLine.slice(newline + 1);
              }
            }
            // Only synthesis writes outer prose. Clarification is an internal
            // decision: even a provider's unsolicited full answer is discarded.
            // Validated ask_user activities below remain visible at the current offset.
          }
          const isKnowledge =
            (part.type === "tool-call" || part.type === "tool-result") &&
            Schema.is(KnowledgeToolName)(part.name);
          if (
            part.type === "tool-call" &&
            (part.name === "ask_user" ||
              part.name === "web_search" ||
              part.name === "read_url" ||
              isKnowledge)
          ) {
            const rowId = uuidv7();
            rows.set(part.id, rowId);
            const index = callIndex++;
            const textOffset = part.name === "ask_user" ? deps.getTextOffset() : 0;
            yield* store.locked(fence, (tx) =>
              tx
                .insert(messageToolCalls)
                .values({
                  id: rowId,
                  messageId: fence.messageId,
                  researchRunId: fence.runId,
                  researchTaskId: input.taskId ?? null,
                  turnIndex: reservation.ordinal,
                  callIndex: index,
                  textOffset,
                  providerCallId: `${id}:${part.id}`,
                  toolName: part.name,
                  arguments: json(part.params),
                  status: "running",
                })
                .pipe(Effect.orDie, Effect.asVoid),
            );
            const args = part.params as { queries?: string[]; urls?: string[] };
            if (part.name === "ask_user")
              yield* deps.emit({
                v: 1,
                family: "ask",
                phase: "start",
                callId: rowId,
                name: part.name,
                turnIndex: reservation.ordinal,
                callIndex: index,
                textOffset,
              });
            else if (isKnowledge)
              yield* deps.emit({
                v: 1,
                family: "knowledge",
                phase: "start",
                callId: rowId,
                runId: fence.runId,
                ...(input.taskId ? { taskId: input.taskId } : {}),
                name: part.name as typeof KnowledgeToolName.Type,
                turnIndex: reservation.ordinal,
                callIndex: index,
                textOffset,
              });
            else
              yield* deps.emit({
                v: 1,
                family: "web",
                phase: "start",
                callId: rowId,
                runId: fence.runId,
                ...(input.taskId ? { taskId: input.taskId } : {}),
                name: part.name,
                turnIndex: reservation.ordinal,
                callIndex: index,
                textOffset,
                args: { targets: args.queries ?? args.urls ?? [] },
              });
          }
          if (part.type === "tool-result") {
            const rowId = rows.get(part.id);
            if (!rowId) return;
            if (part.name === "ask_user") {
              if (preliminary) return;
              const decoded = Schema.decodeUnknownOption(AskUserResult)(part.result);
              const result: AskUserResult =
                !part.isFailure && Option.isSome(decoded)
                  ? decoded.value
                  : { v: 1, outcome: "rejected", message: "Questions could not be presented." };
              presented ||= result.outcome === "presented";
              yield* store.locked(fence, (tx) =>
                tx
                  .update(messageToolCalls)
                  .set({
                    result: json(result),
                    status: result.outcome === "presented" ? "complete" : "error",
                    completedAt: new Date(),
                  })
                  .where(eq(messageToolCalls.id, rowId))
                  .pipe(Effect.orDie, Effect.asVoid),
              );
              yield* deps.emit({
                v: 1,
                family: "ask",
                phase: "result",
                callId: rowId,
                name: part.name,
                result,
              });
              return;
            }
            const lineage = {
              runId: fence.runId,
              ...(input.taskId ? { taskId: input.taskId } : {}),
            };
            if (isKnowledge) {
              if (preliminary) return;
              const activity = projectKnowledgeToolResult(
                part.result,
                part.isFailure,
                knowledgeTools?.remaining() ?? 0,
              );
              yield* store.locked(fence, (tx) =>
                tx
                  .update(messageToolCalls)
                  .set({
                    result: json(activity),
                    status: activity.ok ? "complete" : "error",
                    completedAt: new Date(),
                  })
                  .where(eq(messageToolCalls.id, rowId))
                  .pipe(Effect.orDie, Effect.asVoid),
              );
              for (const source of activity.sources) {
                sources.set(source.index, mergeSource(sources.get(source.index), source));
                const local = input.taskId ? taskSources.get(input.taskId) : undefined;
                local?.set(source.index, mergeSource(local.get(source.index), source));
              }
              yield* deps.emit({
                v: 1,
                phase: "result",
                callId: rowId,
                name: part.name as typeof KnowledgeToolName.Type,
                ...lineage,
                ...activity,
              });
              return;
            }
            const result = part.result as WebToolResult;
            const summary = {
              targets: result?.targets ?? [],
              resultCount: result?.resultCount ?? 0,
              pagesFetched: result?.pagesFetched ?? 0,
            };
            if (preliminary) {
              yield* deps.emit({
                v: 1,
                family: "web",
                phase: "progress",
                callId: rowId,
                name: part.name,
                ...lineage,
                summary,
                pages: result?.pages ?? [],
              });
              return;
            }
            const ok = !part.isFailure && result?.ok === true;
            // A failed search or page read is the worker's job to route around
            // (the prompt says so), and the activity panel lists it for the
            // curious. It is not a limitation of the answer. A run of failed
            // searches with no success between them is different: that is the
            // backend down, and the budget latches exploration off.
            yield* store.locked(fence, (tx) =>
              tx
                .update(messageToolCalls)
                .set({
                  result: json({
                    ...summary,
                    sources: result?.sources ?? [],
                    pages: result?.pages ?? [],
                    failures: result?.failures ?? [],
                  }),
                  status: ok ? "complete" : "error",
                  completedAt: new Date(),
                })
                .where(eq(messageToolCalls.id, rowId))
                .pipe(Effect.orDie, Effect.asVoid),
            );
            for (const source of result?.sources ?? []) {
              sources.set(source.index, mergeSource(sources.get(source.index), source));
              const local = input.taskId ? taskSources.get(input.taskId) : undefined;
              local?.set(source.index, mergeSource(local.get(source.index), source));
            }
            yield* deps.emit({
              v: 1,
              family: "web",
              phase: "result",
              callId: rowId,
              name: part.name,
              ...lineage,
              ok,
              summary,
              sources: result?.sources ?? [],
              pages: result?.pages ?? [],
            });
          }
        }),
      ),
      // The run deadline still bounds the call; provider silence is handled per
      // pull above, so a long-but-productive tool round is never cut short.
      Effect.timeout(
        Duration.millis(Math.max(1, deps.startedAt + RESEARCH_LIMITS.overallMs - Date.now())),
      ),
      Effect.catchTag(
        "TimeoutError",
        () => new ResearchExecutionError({ reason: "provider_timeout" }),
      ),
    );
    if (knowledgeTools) yield* knowledgeTools.authorize();
    if (phase === "synthesis" && synthesisLine) {
      const checked = validateResearchCitations(synthesisLine, citationIds());
      if (checked.invalid) limitations.add("Unregistered final citation references were removed.");
      yield* deps.text(checked.text);
    }
    if (!finishReason)
      limitations.add("A provider call ended without a finish/usage confirmation.");
    return { text, parts, finishReason, presented, usage, finishMetadata: metadata };
  });

  const compactionPositions = new Map<
    string,
    {
      beforeTurnIndex: number;
      passIndex: number;
      scope: "history" | "active_rounds";
      taskId?: string;
    }
  >();
  const compactionDepsFor = (taskId?: string): CompactionDeps => ({
    gateway: {
      generateText: (input) =>
        invoke({
          ...input,
          spec: {
            phase: "compaction",
            maxOutputTokens: input.maxOutputTokens ?? specs.compaction.maxOutputTokens,
          },
          ...(taskId ? { taskId } : {}),
        }).pipe(
          Effect.map((result) => ({
            text: result.text,
            usage: result.usage,
            finishMetadata: result.finishMetadata,
          })),
        ),
    },
    providers: deps.providers,
    // Each compaction invocation checkpoints its own immutable ledger row, including on Stop.
    analytics: { record: () => Effect.void },
    repo: {
      createCompactionEvent: (input) =>
        Effect.gen(function* () {
          const position = {
            beforeTurnIndex: budget.calls + 1,
            passIndex: ++compactionPosition,
            scope: input.scope,
            ...(taskId ? { taskId } : {}),
          };
          compactionPositions.set(input.id, position);
          yield* store.locked(fence, (tx) =>
            tx
              .insert(messageCompactionEvents)
              .values({
                ...input,
                beforeTurnIndex: position.beforeTurnIndex,
                passIndex: position.passIndex,
                researchRunId: fence.runId,
                researchTaskId: taskId ?? null,
                status: "running",
              })
              .pipe(Effect.orDie, Effect.asVoid),
          );
          yield* deps.emitCompaction({
            v: 1,
            phase: "start",
            eventId: input.id,
            ...position,
            textOffset: 0,
            runId: fence.runId,
          });
        }),
      completeCompactionEvent: (input) =>
        Effect.gen(function* () {
          yield* store.locked(fence, (tx) =>
            tx
              .update(messageCompactionEvents)
              .set({ ...input, completedAt: new Date() })
              .where(eq(messageCompactionEvents.id, input.id))
              .pipe(Effect.orDie, Effect.asVoid),
          );
          const position = compactionPositions.get(input.id)!;
          yield* deps.emitCompaction({
            v: 1,
            phase: "result",
            eventId: input.id,
            ...position,
            textOffset: 0,
            runId: fence.runId,
            ok: input.status === "complete",
            ...(input.summary ? { summary: input.summary } : {}),
            ...(input.outcome ? { outcome: input.outcome } : {}),
          });
        }),
      insertCompactionCheckpoint: (input) =>
        store.locked(fence, (tx) =>
          tx
            .insert(conversationCompactionCheckpoints)
            .values({ ...input, id: uuidv7() })
            .onConflictDoNothing()
            .returning()
            .pipe(
              Effect.orDie,
              Effect.map((rows) => rows[0] ?? null),
            ),
        ),
    },
  });
  const compactionDeps = compactionDepsFor();
  // Keep the clarification/answer boundary and apply the ordinary history compaction policy.
  const calls = yield* deps.repo.listToolCalls(
    deps.history.filter((message) => message.role === "assistant").map((message) => message.id),
  );
  const questionContexts = new Map(
    calls.flatMap((call) => {
      const q = readPresentedQuestions(call.result);
      return q ? [[call.messageId, formatQuestionContext(q)] as const] : [];
    }),
  );
  const linkedAnswer = deps.history.at(-1)?.questionResponse != null;
  const protectedStart = linkedAnswer ? Math.max(0, deps.history.length - 3) : undefined;
  const checkpoints = yield* deps.repo.listCompactionCheckpoints(fence.conversationId);
  const selected = latestValidCheckpoint(
    deps.history,
    protectedStart === undefined
      ? checkpoints
      : checkpoints.filter(
          (checkpoint) =>
            deps.history.findIndex((m) => m.id === checkpoint.throughMessageId) < protectedStart,
        ),
  );
  const offset = selected ? selected.index + 1 : 0;
  const history = deps.history.slice(offset).map((message) => ({
    ...message,
    content: questionContexts.has(message.id)
      ? `${message.content}\n${questionContexts.get(message.id)}`
      : message.content,
  }));
  const rendered = yield* buildHistoryMessages(deps.promptDeps, {
    messages: history,
    webToolsEnabled: true,
    modelSupportsFiles: model?.capabilities.files ?? false,
  });
  // Agent instructions are user-level configuration: a separate, lower-authority
  // message after the application policy, never merged into it.
  const agentInstructions: Prompt.MessageEncoded[] = deps.config.snapshot?.instructions.trim()
    ? [
        {
          role: "user",
          content: `<agent-instructions name=${JSON.stringify(deps.config.snapshot.name)}>\n${deps.config.snapshot.instructions}\n</agent-instructions>`,
        },
      ]
    : [];
  const knowledgePolicy: Prompt.MessageEncoded[] = deps.knowledge
    ? [{ role: "system", content: KNOWLEDGE_SYSTEM_HINT }]
    : [];
  const fixedPrefix: Prompt.MessageEncoded[] = [
    { role: "system", content: prompts.researchPolicy },
    ...knowledgePolicy,
    ...agentInstructions,
  ];
  let historyProjection:
    | Pick<CompactionDecision, "startIndex" | "injectedMessages" | "checkpoint">
    | undefined;
  let researchPlan = "";
  let evidenceSummary: string | null = null;
  let evidenceRounds: ReadonlyArray<ActiveRound> = [];
  const evidenceBlocks = new Map<number, EvidenceBlock>();
  const observedTasks = new Set<string>();
  let evidenceOrdinal = 0;
  const appendEvidence = (block: EvidenceBlock) => {
    const turnIndex = ++evidenceOrdinal;
    evidenceBlocks.set(turnIndex, block);
    evidenceRounds = [
      ...evidenceRounds,
      { turnIndex, prompt: evidencePrompt(`${block.label}\n${block.text}`) },
    ];
  };
  const currentEvidence = (): EvidenceBlock[] => [
    ...(evidenceSummary ? [{ label: "Evidence briefing (data)", text: evidenceSummary }] : []),
    ...evidenceRounds.map((round) => evidenceBlocks.get(round.turnIndex)!),
  ];
  const stage = Effect.fn("research.stage")(function* (
    spec: ResearchCallSpec,
    policy: string,
    data = "",
    notice = "",
  ) {
    const usesEvidence = spec.phase === "coordinator" || spec.phase === "synthesis";
    if (usesEvidence) {
      if (evidenceOrdinal === 0)
        appendEvidence({ label: "Research plan (data)", text: researchPlan });
      for (const task of tasks) {
        if (observedTasks.has(task.id) || task.status === "queued" || task.status === "running")
          continue;
        observedTasks.add(task.id);
        appendEvidence({
          label: `Task ${task.ordinal}: ${task.title} (${task.status})`,
          text: task.report || task.error || "No findings available.",
        });
      }
    }
    const request: Prompt.MessageEncoded = {
      role: "user",
      content: [prompts.stageRequest, data, notice].filter(Boolean).join("\n"),
    };
    const stagePrefix: Prompt.MessageEncoded[] = [
      deps.runtimeContext,
      { role: "system", content: policy },
    ];
    const inputBudget = computeBudget({
      contextLength: model?.contextLength,
      outputReserve: spec.maxOutputTokens,
      webToolsEnabled: spec.phase === "coordinator" || spec.phase === "clarification",
    }).input;
    const protectedIndex = Math.max(
      0,
      (protectedStart ?? deps.history.map((message) => message.role).lastIndexOf("user")) - offset,
    );
    const protectedTokens = estimatePromptTokens([
      ...fixedPrefix,
      ...rendered.slice(protectedIndex),
      ...stagePrefix,
      request,
    ]);
    const allowance = Math.max(
      0,
      Math.min(Math.floor(inputBudget * 0.45), inputBudget - protectedTokens - 128),
    );
    const fallback = usesEvidence
      ? boundEvidence(currentEvidence(), registeredSources(), allowance)
      : { text: "", abridged: false };
    const trailingMessages: Prompt.MessageEncoded[] = [
      ...stagePrefix,
      ...(fallback.text ? [{ role: "assistant" as const, content: fallback.text }] : []),
      request,
    ];
    const decision = yield* prepareCompactedHistory(compactionDeps, {
      userId: deps.userId,
      conversationId: fence.conversationId,
      messageId: fence.messageId,
      modelId: deps.modelId,
      contextLength: model?.contextLength,
      outputReserve: spec.maxOutputTokens,
      existingCheckpoint: selected?.checkpoint ?? null,
      ...(historyProjection ? { projection: historyProjection } : {}),
      messages: history,
      renderedMessages: rendered,
      fixedPrefix,
      trailingMessages,
      webToolsEnabled: spec.phase === "coordinator" || spec.phase === "clarification",
      maxStartIndex: protectedIndex,
    });
    historyProjection = decision;
    const baseMessages = [
      ...fixedPrefix,
      ...decision.injectedMessages,
      ...rendered.slice(decision.startIndex),
      ...stagePrefix,
    ];
    let evidence = "";
    if (usesEvidence) {
      const original = currentEvidence();
      const raw = original.map((block) => `${block.label}\n${block.text}`).join("\n\n");
      const reduced = yield* prepareCompactedActiveRounds(compactionDeps, {
        userId: deps.userId,
        conversationId: fence.conversationId,
        messageId: fence.messageId,
        modelId: deps.modelId,
        contextLength: model?.contextLength,
        outputReserve: spec.maxOutputTokens,
        webToolsEnabled: spec.phase === "coordinator",
        basePrompt: Prompt.make(baseMessages),
        summary: evidenceSummary,
        rounds: evidenceRounds,
        beforeTurnIndex: budget.calls + 1,
        passIndex: 0,
        textOffset: 0,
        calibrationFactor: 1,
        sourceManifest: evidenceManifest(raw, registeredSources()),
        trailingPrompt: Prompt.make([
          { role: "assistant", content: evidenceManifest(raw, registeredSources()) },
          request,
        ]),
      });
      evidenceSummary = reduced.summary;
      evidenceRounds = reduced.rounds;
      const available = Math.max(
        0,
        inputBudget - estimatePromptTokens([...baseMessages, request]) - 16,
      );
      const projected = boundEvidence(currentEvidence(), registeredSources(), available);
      // A failed compaction's generic omission notice is not a substitute for
      // task evidence: retain bounded original findings across all tasks instead.
      const lostEvidence =
        reduced.compacted && reduced.summary?.includes("could not be summarized");
      const chosen =
        projected.abridged || lostEvidence
          ? boundEvidence(original, registeredSources(), available)
          : projected;
      evidence = chosen.text;
      if (!evidence) return yield* new ResearchExecutionError({ reason: "context" });
      if (chosen.abridged || lostEvidence) {
        limitations.add("Some collected evidence was abridged to fit the model context.");
        evidenceSummary = `${evidence}\nEvidence was abridged; do not infer omitted findings.`;
        evidenceRounds = [];
      }
    }
    const finalTail = (): Prompt.MessageEncoded[] => [
      ...stagePrefix,
      ...(evidence ? [{ role: "assistant" as const, content: evidence }] : []),
      request,
    ];
    const compile = (value: Pick<CompactionDecision, "injectedMessages" | "startIndex">) =>
      Prompt.make([
        ...fixedPrefix,
        ...value.injectedMessages,
        ...rendered.slice(value.startIndex),
        ...finalTail(),
      ]);
    return {
      prompt: compile(decision),
      repair: () => {
        const rejectedEstimate = estimatePromptTokens(
          compile(decision).content as ReadonlyArray<Prompt.MessageEncoded>,
        );
        if (evidence) {
          const smaller = boundEvidence(
            currentEvidence(),
            registeredSources(),
            Math.floor(evidenceTokens(evidence) * 0.5),
          );
          if (smaller.text) {
            evidence = smaller.text;
            evidenceSummary = evidence;
            evidenceRounds = [];
            if (smaller.abridged)
              limitations.add("Some collected evidence was abridged to fit the model context.");
          }
        }
        const reduced = shrinkForOverflow({
          decision: { ...decision, estimatedInputTokens: rejectedEstimate },
          messages: history,
          renderedMessages: rendered,
          fixedPrefix,
          trailingMessages: finalTail(),
          calibrationFactor: 1,
          maxStartIndex: protectedIndex,
        });
        if (reduced) {
          historyProjection = { ...reduced, checkpoint: null };
          return compile(reduced);
        }
        // Evidence can shrink even when protected history leaves no removable turn.
        const repaired = compile(decision);
        return estimatePromptTokens(repaired.content as ReadonlyArray<Prompt.MessageEncoded>) <
          rejectedEstimate
          ? repaired
          : null;
      },
    };
  });
  const invokeStage = Effect.fn("research.invokeStage")(function* (input: {
    phase: ResearchCallPhase;
    policy: string;
    data?: string;
    notice?: string;
    toolkit?: Toolkit.WithHandler<any> | undefined;
  }) {
    const prepared = yield* stage(specs[input.phase], input.policy, input.data, input.notice);
    return yield* invoke({ ...input, spec: specs[input.phase], prompt: prepared.prompt }).pipe(
      Effect.catchTag("ProviderContextOverflow", (error) => {
        const repaired = prepared.repair();
        if (!repaired) return Effect.fail(error);
        limitations.add(
          "Earlier conversational context was reduced after a provider context rejection.",
        );
        return invoke({ ...input, spec: specs[input.phase], prompt: repaired });
      }),
    );
  });
  if (!linkedAnswer) {
    yield* update("clarifying");
    const toolkit = yield* mergeToolGroups([prepareAskUserTool()]);
    const clarification = yield* invokeStage({
      phase: "clarification",
      policy: prompts.clarificationPolicy,
      toolkit,
    });
    if (clarification.presented) {
      yield* update("awaiting_answer");
      return "awaiting_answer" as const;
    }
  }
  yield* update("planning");
  const plan = yield* invokeStage({ phase: "planning", policy: prompts.planningPolicy });
  researchPlan = plan.text;
  yield* update("researching");

  /** The live budget a worker sees, always last so the prompt prefix stays cacheable. */
  const workerTail = (wave: number) => {
    const left = budget.remaining();
    const share = Math.max(1, wave);
    const knowledgeLine = knowledgeTools
      ? ` Knowledge operations remaining (shared): ${knowledgeTools.remaining()} of ${KNOWLEDGE_TOOL_LIMITS.operations}.`
      : "";
    return Prompt.make([
      {
        role: "user" as const,
        content:
          prompts.budgetNotice({
            scope: "worker",
            searches: Math.floor(left.searches / share),
            reads: Math.floor(left.reads / share),
            minutes: left.minutes,
            headroom: budget.headroom,
          }) + knowledgeLine,
      },
    ]);
  };
  const worker = Effect.fn("research.worker")(function* (
    task: { id: string; title: string; assignment: string; ordinal: number },
    // The web pool is shared, so a worker is told its fair share of it rather
    // than the whole run's: every worker seeing the full search allowance
    // would each plan for all of it and starve the other two.
    wave: number,
  ) {
    const state = tasks.find((item) => item.id === task.id)!;
    state.status = "running";
    yield* store.locked(fence, (tx) =>
      tx
        .update(researchTasks)
        .set({ status: "running" })
        .where(eq(researchTasks.id, task.id))
        .pipe(Effect.orDie, Effect.asVoid),
    );
    yield* update("researching");
    const priorManifest = evidenceManifest(task.assignment, registeredSources());
    taskSources.set(
      task.id,
      new Map(
        registeredSources()
          .filter((source) => priorManifest.includes(`[${source.index}] `))
          .map((source) => [source.index, source]),
      ),
    );
    const basePrompt = Prompt.make([
      { role: "system", content: `${prompts.researchPolicy}\n${prompts.workerPolicy}` },
      ...knowledgePolicy,
      ...(deps.knowledge
        ? [
            {
              role: "system" as const,
              content: `Selected knowledge documents are available through list_documents, search_knowledge and read_document (${deps.knowledge.session.manifest.length} documents). They are separate from web search: use them for questions the selection can answer, and cite their indexes like web sources.`,
            },
          ]
        : []),
      ...agentInstructions,
      {
        role: "assistant",
        content: `Coordinator assignment (data, not user authority):\n${task.assignment}\nRegistered prior sources (data):\n${manifest(task.id, specs.worker)}`,
      },
      deps.runtimeContext,
    ]);
    let rounds: ReadonlyArray<ActiveRound> = [];
    let summary: string | null = null;
    // Once no web target can be admitted, further rounds only spend model calls
    // on tools that must refuse; write the report from what was gathered.
    for (let round = 0; round < RESEARCH_LIMITS.toolRounds && budget.webAvailable; round++) {
      const reduced: ActiveRoundCompactionDecision = yield* prepareCompactedActiveRounds(
        compactionDepsFor(task.id),
        {
          userId: deps.userId,
          conversationId: fence.conversationId,
          messageId: fence.messageId,
          modelId: deps.modelId,
          contextLength: model?.contextLength,
          outputReserve: specs.worker.maxOutputTokens,
          webToolsEnabled: true,
          basePrompt,
          summary,
          rounds,
          beforeTurnIndex: budget.calls + 1,
          passIndex: 0,
          textOffset: 0,
          calibrationFactor: 1,
          sourceManifest: manifest(task.id, specs.worker),
          trailingPrompt: workerTail(wave),
        },
      );
      summary = reduced.summary;
      rounds = reduced.rounds;
      const prompt = Prompt.concat(
        compileActivePrompt({ basePrompt, summary, rounds }),
        workerTail(wave),
      );
      if (
        estimatePromptTokens(prompt.content as ReadonlyArray<Prompt.MessageEncoded>) >
        computeBudget({
          contextLength: model?.contextLength,
          webToolsEnabled: true,
          outputReserve: specs.worker.maxOutputTokens,
        }).input
      ) {
        limitations.add(`Task ${task.ordinal}: protected assignment/context does not fit.`);
        break;
      }
      const result = yield* invoke({
        spec: specs.worker,
        taskId: task.id,
        prompt,
        toolkit: workerToolkit,
      });
      rounds = [
        ...rounds,
        { turnIndex: budget.calls, prompt: Prompt.fromResponseParts(result.parts) },
      ];
      if (result.finishReason !== "tool-calls") break;
    }
    const reportTail = Prompt.make([
      { role: "system", content: prompts.reportPolicy },
      { role: "assistant", content: `Registered sources:\n${manifest(task.id, specs.report)}` },
      { role: "user", content: prompts.reportRequest },
    ]);
    const reportContext: ActiveRoundCompactionDecision = yield* prepareCompactedActiveRounds(
      compactionDepsFor(task.id),
      {
        userId: deps.userId,
        conversationId: fence.conversationId,
        messageId: fence.messageId,
        modelId: deps.modelId,
        contextLength: model?.contextLength,
        outputReserve: specs.report.maxOutputTokens,
        webToolsEnabled: true,
        basePrompt,
        summary,
        rounds,
        beforeTurnIndex: budget.calls + 1,
        passIndex: 0,
        textOffset: 0,
        calibrationFactor: 1,
        sourceManifest: manifest(task.id, specs.report),
        trailingPrompt: reportTail,
      },
    );
    summary = reportContext.summary;
    rounds = reportContext.rounds;
    const report = yield* invoke({
      spec: specs.report,
      taskId: task.id,
      prompt: Prompt.concat(compileActivePrompt({ basePrompt, summary, rounds }), reportTail),
    });
    const validated = validateResearchCitations(report.text, citationIds());
    if (validated.invalid)
      limitations.add(`Task ${task.ordinal}: unregistered citation references were removed.`);
    if (report.finishReason === "length")
      limitations.add(
        `Task ${task.ordinal}: report reached the model output limit; some findings may be incomplete.`,
      );
    state.report = validated.text;
    state.status = state.report.trim() ? "complete" : "error";
    // The panel shows a failed task's reason; a silent "Failed" after a full
    // investigation reads as if the searches were the problem.
    if (state.status === "error") {
      state.error = "The model returned no report for this task.";
      limitations.add(`Task ${task.ordinal}: ${state.error}`);
    }
    yield* store.locked(fence, (tx) =>
      tx
        .update(researchTasks)
        .set({ status: state.status, report: state.report ?? null, error: state.error ?? null })
        .where(eq(researchTasks.id, task.id))
        .pipe(Effect.orDie, Effect.asVoid),
    );
    yield* update("researching");
  });
  const explore = Effect.gen(function* () {
    for (let round = 0; round < RESEARCH_LIMITS.coordinatorRounds && budget.exploring; round++) {
      const assignments: Array<{ id: string; ordinal: number; title: string; assignment: string }> =
        [];
      let finish = false;
      const toolkit = yield* mergeToolGroups([
        {
          toolkit: ResearchCoordinatorTools,
          handlers: {
            dispatch_research: (params: typeof DispatchParams.Type) =>
              Effect.sync(() => {
                let accepted = 0;
                for (const task of params.tasks)
                  if (budget.admitTask()) {
                    assignments.push({ ...task, id: uuidv7(), ordinal: budget.tasks });
                    accepted++;
                  }
                return { accepted };
              }),
            finish_research: () =>
              Effect.sync(() => {
                finish = true;
                return { ok: true };
              }),
          },
        },
      ]);
      const left = budget.remaining();
      yield* invokeStage({
        phase: "coordinator",
        policy: prompts.coordinatorPolicy,

        notice: prompts.budgetNotice({
          scope: "coordinator",
          searches: left.searches,
          reads: left.reads,
          tasks: left.tasks,
          rounds: RESEARCH_LIMITS.coordinatorRounds - round - 1,
          minutes: left.minutes,
          headroom: budget.headroom,
        }),
        toolkit,
      });
      if (!assignments.length) {
        // No room left is the bound doing its job; only a round that could have
        // dispatched and produced nothing usable is worth reporting.
        if (finish || !budget.canDispatch) break;
        limitations.add("A coordinator round dispatched no useful tasks.");
        continue;
      }
      for (const task of assignments) {
        tasks.push({ id: task.id, ordinal: task.ordinal, title: task.title, status: "queued" });
        yield* store.locked(fence, (tx) =>
          tx
            .insert(researchTasks)
            .values({ ...task, runId: fence.runId })
            .pipe(Effect.orDie, Effect.asVoid),
        );
      }
      yield* update("researching");
      yield* Effect.forEach(
        assignments,
        (task) =>
          worker(task, assignments.length).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                if (!(yield* store.alive(fence)))
                  return yield* Effect.die(new Error("Research stopped"));
                if (knowledgeTools) yield* knowledgeTools.authorize();
                const state = tasks.find((item) => item.id === task.id)!;
                state.status = "error";
                state.error = researchFailureMessage(cause);
                limitations.add(`Task ${task.ordinal}: ${state.error}`);
                yield* store.locked(fence, (tx) =>
                  tx
                    .update(researchTasks)
                    .set({ status: "error", error: state.error ?? null })
                    .where(eq(researchTasks.id, task.id))
                    .pipe(Effect.orDie, Effect.asVoid),
                );
                yield* update("researching");
              }),
            ),
          ),
        { concurrency: RESEARCH_LIMITS.workers, discard: true },
      );
      if (finish) break;
    }
  });
  yield* explore.pipe(
    Effect.timeout(
      Duration.millis(Math.max(1, deps.startedAt + RESEARCH_LIMITS.explorationMs - Date.now())),
    ),
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        if (!(yield* store.alive(fence))) return yield* Effect.die(new Error("Research stopped"));
        if (knowledgeTools) yield* knowledgeTools.authorize();
        limitations.add(researchFailureMessage(cause));
      }),
    ),
  );
  for (const task of tasks)
    if (task.status === "running" || task.status === "queued") task.status = "aborted";
  if (budget.searchUnavailable)
    limitations.add("Web search was unavailable, so most of the investigation could not run.");
  if (!tasks.some((task) => task.status === "complete" && task.report?.trim())) {
    limitations.add("No usable research reports were produced.");
    yield* update("error");
    return "error" as const;
  }
  yield* update("synthesizing");
  const beforeSynthesis = deps.getTextOffset();
  const final = yield* invokeStage({
    phase: "synthesis",
    policy: prompts.synthesisPolicy,
    // The ceiling is not a user-facing limitation, but the answer still has to
    // say it explored only so far — that disclosure is the model's job.
    data: `Limitations:\n${[...limitations].join("\n")}\nExecution bounds:\n${budget.searchUnavailable ? "The web search service was unavailable during this run, so investigation could not proceed. Say so plainly." : budget.webRefused ? "Exploration reached its search/read ceiling; some avenues were left unexplored." : "None reached."}`,
  }).pipe(
    // Synthesis emits validated lines as they arrive. Once the reader has an
    // answer on screen, a failure on the way to the finish part is a truncated
    // report, not a failed run — discarding it would delete what they can read.
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        if (!(yield* store.alive(fence)) || deps.getTextOffset() === beforeSynthesis)
          return yield* Effect.failCause(cause);
        limitations.add(researchFailureMessage(cause));
        if (knowledgeTools) yield* knowledgeTools.authorize();
        limitations.add("The final report was cut short.");
        return null;
      }),
    ),
  );
  if (final === null) {
    yield* update("partial");
    return "partial" as const;
  }
  const validated = validateResearchCitations(final.text, citationIds());
  if (validated.invalid) limitations.add("Unregistered final citation references were removed.");
  if (!validated.text.trim()) {
    yield* update("error");
    return "error" as const;
  }
  const phase = limitations.size ? "partial" : "complete";
  yield* update(phase);
  return phase;
});
