import { SaveMemoryResult } from "~/modules/memory/server/memory-tool.ts";
import {
  AgentDraftToolName,
  agentDraftFailureReason,
  projectAgentDraftResult,
  agentDraftResultOk,
  redactAgentDraftPart,
} from "~/modules/agents/tool-schema.ts";
import { SkillReader } from "~/modules/skills/server/reader.ts";
import { prepareSkillTools } from "~/modules/skills/server/tools.ts";
import { SkillToolName, projectSkillToolResult } from "~/modules/skills/tool-schema.ts";
import { eq } from "drizzle-orm";
import { Cause, Duration, Effect, Option, Schema, Semaphore, Stream } from "effect";
import { Prompt, Response, Toolkit } from "effect/unstable/ai";
import { uuidv7 } from "uuidv7";
import {
  conversationCompactionCheckpoints,
  messageCompactionEvents,
  messageToolCalls,
  researchCalls,
  researchRuns,
  usageEvents,
} from "~/db/schema/index.ts";
import type { JsonValue } from "~/db/schema/providers.ts";
import { addFinishUsage, emptyUsageTotals, resolveCost } from "~/modules/analytics/server/usage.ts";
import { ProviderUnreachable, type AiGateway } from "~/modules/providers/server/gateway.ts";
import type { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { AskUserResult } from "~/modules/tools/ask-user-schema.ts";
import type { Source, ToolChunkEnvelope, WebToolResult } from "~/modules/tools/schema.ts";
import { createSourceIndexer } from "~/modules/tools/server/source-indexer.ts";
import type { KnowledgeSearchSession } from "~/modules/knowledge/server/search.ts";
import { KnowledgeService } from "~/modules/knowledge/server/service.ts";
import { prepareKnowledgeTools } from "~/modules/knowledge/server/tools.ts";
import { KnowledgeToolName, projectKnowledgeToolResult } from "~/modules/knowledge/tool-schema.ts";
import type { GenerationConfig } from "../repo.ts";
import { isWebSource, mergeSource, mergeSources } from "~/modules/tools/sources.ts";
import { createUrlAuthority } from "~/modules/tools/server/url-authority.ts";
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
  computeBudget,
  estimatePromptTokens,
  type CompactionDeps,
} from "../compaction.ts";
import {
  ResearchBudget,
  RESEARCH_LIMITS,
  researchOutputCaps,
  researchPhaseSpecs,
  type ResearchCallSpec,
  validateResearchCitations,
} from "./budget.ts";
import { initialResearchProgress, type ResearchFence, type ResearchStore } from "./repo.ts";
import { boundedSourceManifest } from "./evidence.ts";

/**
 * Child rows of a run share `message_tool_calls` with the host turn that made
 * the call, and that table is unique on (message, turn, call). Runs keep their
 * ordinal space above every reachable host turn so the two never collide; each
 * run starts past the positions earlier runs on the message used.
 */
export const RESEARCH_TURN_BASE = 1000;

const json = (value: unknown) => value as JsonValue;

export class ResearchExecutionError extends Schema.TaggedError<ResearchExecutionError>()(
  "ResearchExecutionError",
  { reason: Schema.Literals(["context", "budget", "provider_timeout"]) },
) {}

/**
 * Only fixed application-owned diagnostics leave this boundary. Provider errors
 * can contain request bodies, credentials or fetched content; never display them.
 */
export const researchFailureMessage = (cause: Cause.Cause<unknown>): string => {
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

export const makeResearchExecution = Effect.fn("research.execution")(function* (deps: {
  store: ResearchStore;
  fence: ResearchFence;
  gateway: AiGateway["Service"];
  providers: ProviderRepo["Service"];
  webSearch: WebSearchExecutor["Service"];
  urlReader: UrlReaderExecutor["Service"];
  userUrls: ReadonlyArray<string>;
  priorSources: ReadonlyArray<Source>;
  /** The frozen configuration of this generation. */
  config: GenerationConfig;
  /** Open when the configuration selects knowledge; shared by every worker. */
  knowledge: {
    session: KnowledgeSearchSession;
    service: KnowledgeService["Service"];
  } | null;
  skillReader?: SkillReader["Service"];
  modelId: string;
  userId: string;
  /** The `deep_research` row this run answers, and the ordinals it renders under. */
  call: {
    readonly rowId: string;
    readonly turnIndex: number;
    readonly callIndex: number;
    readonly textOffset?: number;
  };
  startedAt: number;
  /** What the reader sees the run called; the host writes it with the brief. */
  title?: string;
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
  const turnBase = Math.max(RESEARCH_TURN_BASE, (yield* store.lastRunPosition(fence)) + 1);
  const external = yield* Semaphore.make(RESEARCH_LIMITS.externalOps);
  const progressWriter = yield* Semaphore.make(1);
  const sources = new Map<number, Source>();
  const registeredSources = () => mergeSources([...deps.priorSources, ...sources.values()]);
  const citationIds = () => new Set(registeredSources().map((source) => source.index));
  let progress = initialResearchProgress(fence.runId, deps.title);
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
              .where(eq(messageToolCalls.id, deps.call.rowId))
              .pipe(Effect.orDie);
          }),
        );
        yield* deps.emit({
          v: 1,
          family: "research",
          name: "deep_research",
          callId: deps.call.rowId,
          runId: fence.runId,
          phase: "progress",
          turnIndex: deps.call.turnIndex,
          callIndex: deps.call.callIndex,
          textOffset: deps.call.textOffset ?? 0,
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
      // The row is the model's own call, minted by the stream observer. It
      // carries no `researchRunId`: that marks a row produced *inside* a run,
      // and the transcript hides those behind this one.
      yield* tx
        .update(messageToolCalls)
        .set({ result: json({ progress, sources: [] }) })
        .where(eq(messageToolCalls.id, deps.call.rowId))
        .pipe(Effect.orDie);
    }),
  );
  yield* deps.emit({
    v: 1,
    family: "research",
    name: "deep_research",
    callId: deps.call.rowId,
    runId: fence.runId,
    phase: "start",
    turnIndex: deps.call.turnIndex,
    callIndex: deps.call.callIndex,
    textOffset: deps.call.textOffset ?? 0,
    progress,
  });
  yield* update();
  const indexer = createSourceIndexer(deps.priorSources);
  const web = yield* prepareWebTools({
    webSearch: deps.webSearch,
    urlReader: deps.urlReader,
    indexer,
    authority: createUrlAuthority([
      ...deps.userUrls,
      ...deps.priorSources.filter(isWebSource).map((source) => source.url),
    ]),
    requestSearch: true,
    owner: deps.userId,
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
  const skillReader =
    deps.skillReader ?? (yield* Effect.die(new Error("Missing research skill reader")));
  // Same offer as ordinary chat: selections are pinned, the library is visible.
  const skillManifest = [
    ...(deps.config.skills ?? []),
    ...(yield* skillReader.catalogue(
      deps.userId,
      (deps.config.skills ?? []).map((entry) => entry.skillId),
    )),
  ];
  const skillTools = skillManifest.length
    ? yield* prepareSkillTools({
        userId: deps.userId,
        manifest: skillManifest,
        maxRootChars: Math.floor(
          computeBudget({ contextLength: model?.contextLength, webToolsEnabled: true }).input * 0.2,
        ),
      }).pipe(Effect.provideService(SkillReader, skillReader))
    : null;

  const skillContext = (): Prompt.MessageEncoded[] => [...(skillTools?.messages() ?? [])];
  for (const [index, entry] of (deps.config.skills ?? [])
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
    yield* store.locked(fence, (tx) =>
      tx
        .insert(messageToolCalls)
        .values({
          id: rowId,
          messageId: fence.messageId,
          researchRunId: fence.runId,
          turnIndex: turnBase,
          callIndex: -5 + index,
          textOffset: 0,
          providerCallId: `skill-context:${rowId}`,
          toolName: "load_skill",
          arguments: {},
          result: json(activity),
          status: "complete",
        })
        .pipe(Effect.orDie),
    );
    yield* deps.emit({
      v: 1,
      family: "skill",
      phase: "start",
      callId: rowId,
      runId: fence.runId,
      name: "load_skill",
      turnIndex: turnBase,
      callIndex: -5 + index,
      textOffset: 0,
      skillId: entry.skillId,
      skillName: entry.name,
      path: "SKILL.md",
    });
    yield* deps.emit({ v: 1, phase: "result", callId: rowId, runId: fence.runId, ...activity });
  }
  const workerToolkit = yield* mergeToolGroups([
    ...(skillTools ? [skillTools.group] : []),
    web.group,
    ...(knowledgeTools ? [knowledgeTools.group] : []),
  ]);
  let compactionPosition = 0;

  const invoke = Effect.fn("research.invoke")(function* (input: {
    spec: ResearchCallSpec;
    prompt: Prompt.Prompt;
    toolkit?: Toolkit.WithHandler<any> | undefined;
    taskId?: string;
    finalText?: ((delta: string) => Effect.Effect<void>) | undefined;
  }) {
    if (!(yield* store.alive(fence)))
      return yield* Effect.die(new Error("Research cancelled or ownership lost"));
    if (skillTools) yield* skillTools.authorize();
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
                            cacheWriteTokens: totals.cacheWriteTokens,
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
          if (!preliminary && part.type !== "error") parts.push(redactAgentDraftPart(part));
          if (part.type === "text-delta") {
            text += part.delta;
            if (input.finalText) {
              synthesisLine += part.delta;
              const newline = synthesisLine.lastIndexOf("\n");
              if (newline >= 0) {
                const checked = validateResearchCitations(
                  synthesisLine.slice(0, newline + 1),
                  citationIds(),
                );
                if (checked.invalid)
                  limitations.add("Unregistered final citation references were removed.");
                yield* input.finalText!(checked.text);
                synthesisLine = synthesisLine.slice(newline + 1);
              }
            }
            // Only synthesis writes outer prose. Clarification is an internal
            // decision: even a provider's unsolicited full answer is discarded.
            // Validated ask_user activities below remain visible at the current offset.
          }
          const isAgentDraft =
            phase === "synthesis" &&
            (part.type === "tool-call" || part.type === "tool-result") &&
            Schema.is(AgentDraftToolName)(part.name);
          const isSkill =
            (part.type === "tool-call" || part.type === "tool-result") &&
            Schema.is(SkillToolName)(part.name);
          const isKnowledge =
            (part.type === "tool-call" || part.type === "tool-result") &&
            Schema.is(KnowledgeToolName)(part.name);
          if (
            part.type === "tool-call" &&
            (part.name === "ask_user" ||
              part.name === "web_search" ||
              part.name === "read_url" ||
              (phase === "planning" && part.name === "save_memory") ||
              isKnowledge ||
              isAgentDraft ||
              isSkill)
          ) {
            const rowId = uuidv7();
            rows.set(part.id, rowId);
            const index = callIndex++;
            const textOffset = part.name === "ask_user" || isAgentDraft ? deps.getTextOffset() : 0;
            yield* store.locked(fence, (tx) =>
              tx
                .insert(messageToolCalls)
                .values({
                  id: rowId,
                  messageId: fence.messageId,
                  researchRunId: fence.runId,
                  researchTaskId: input.taskId ?? null,
                  turnIndex: turnBase + reservation.ordinal,
                  callIndex: index,
                  textOffset,
                  providerCallId: `${id}:${part.id}`,
                  toolName: part.name,
                  arguments:
                    isSkill || isAgentDraft || part.name === "save_memory" ? {} : json(part.params),
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
                turnIndex: turnBase + reservation.ordinal,
                callIndex: index,
                textOffset,
              });
            else if (part.name === "save_memory")
              yield* deps.emit({
                v: 1,
                family: "memory",
                phase: "start",
                callId: rowId,
                name: part.name,
                turnIndex: turnBase + reservation.ordinal,
                callIndex: index,
                textOffset,
              });
            else if (isAgentDraft)
              yield* deps.emit({
                v: 1,
                family: "agent-draft",
                phase: "start",
                callId: rowId,
                name: part.name as AgentDraftToolName,
                turnIndex: turnBase + reservation.ordinal,
                callIndex: index,
                textOffset,
              });
            else if (isSkill) {
              const params = part.params as Record<string, unknown>;
              const entry = deps.config.skills?.find(
                (entry) => entry.skillId === params["skillId"],
              );
              yield* deps.emit({
                v: 1,
                family: "skill",
                phase: "start",
                callId: rowId,
                runId: fence.runId,
                ...(input.taskId ? { taskId: input.taskId } : {}),
                name: part.name as typeof SkillToolName.Type,
                turnIndex: turnBase + reservation.ordinal,
                callIndex: index,
                textOffset,
                skillId: entry?.skillId ?? "",
                skillName: entry?.name ?? "Skill",
                path:
                  part.name === "load_skill"
                    ? "SKILL.md"
                    : typeof params["path"] === "string"
                      ? params["path"].slice(0, 240)
                      : "",
              });
            } else if (isKnowledge)
              yield* deps.emit({
                v: 1,
                family: "knowledge",
                phase: "start",
                callId: rowId,
                runId: fence.runId,
                ...(input.taskId ? { taskId: input.taskId } : {}),
                name: part.name as typeof KnowledgeToolName.Type,
                turnIndex: turnBase + reservation.ordinal,
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
                turnIndex: turnBase + reservation.ordinal,
                callIndex: index,
                textOffset,
                args: { targets: args.queries ?? args.urls ?? [] },
              });
          }
          if (part.type === "tool-result") {
            const rowId = rows.get(part.id);
            if (!rowId) return;
            if (isAgentDraft && Schema.is(AgentDraftToolName)(part.name)) {
              if (preliminary) return;
              const activity = projectAgentDraftResult(part.isFailure ? null : part.result);
              const reason = part.isFailure
                ? "The draft tool failed before it could respond."
                : agentDraftFailureReason(part.result);
              yield* store.locked(fence, (tx) =>
                tx
                  .update(messageToolCalls)
                  .set({
                    result: json(activity),
                    status: agentDraftResultOk(activity) ? "complete" : "error",
                    completedAt: new Date(),
                    ...(reason ? { error: { code: "AgentDraftNotUpdated", message: reason } } : {}),
                  })
                  .where(eq(messageToolCalls.id, rowId))
                  .pipe(Effect.orDie, Effect.asVoid),
              );
              yield* deps.emit({
                v: 1,
                family: "agent-draft",
                phase: "result",
                callId: rowId,
                name: part.name,
                ...activity,
                ...(reason ? { reason } : {}),
              });
              return;
            }
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
            if (part.name === "save_memory") {
              if (preliminary) return;
              const decoded = Schema.decodeUnknownOption(SaveMemoryResult)(part.result);
              const outcome = Option.isSome(decoded) ? decoded.value.outcome : "rejected";
              const reason = Option.isSome(decoded) ? decoded.value.reason : undefined;
              const ok = !part.isFailure && Option.isSome(decoded) && decoded.value.ok;
              // Only the canonical memory record owns its body. Neither arguments,
              // provider errors nor tool response prose enter research persistence.
              yield* store.locked(fence, (tx) =>
                tx
                  .update(messageToolCalls)
                  .set({
                    result: json({ outcome, ...(reason ? { reason } : {}) }),
                    status: ok ? "complete" : "error",
                    completedAt: new Date(),
                  })
                  .where(eq(messageToolCalls.id, rowId))
                  .pipe(Effect.orDie, Effect.asVoid),
              );
              yield* deps.emit({
                v: 1,
                family: "memory",
                phase: "result",
                callId: rowId,
                name: part.name,
                ok,
                outcome,
                ...(reason ? { reason } : {}),
                ...(ok ? {} : { error: "memory was not saved" }),
              });
              return;
            }
            const lineage = {
              runId: fence.runId,
              ...(input.taskId ? { taskId: input.taskId } : {}),
            };
            if (isSkill && Schema.is(SkillToolName)(part.name)) {
              if (preliminary) return;
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
              yield* store.locked(fence, (tx) =>
                tx
                  .update(messageToolCalls)
                  .set({
                    result: json(activity),
                    status: activity.status === "complete" ? "complete" : "error",
                    completedAt: new Date(),
                  })
                  .where(eq(messageToolCalls.id, rowId))
                  .pipe(Effect.orDie, Effect.asVoid),
              );
              yield* deps.emit({ v: 1, phase: "result", callId: rowId, ...lineage, ...activity });
              return;
            }
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
            // A failed search or page read is the worker's job to route around;
            // the activity panel lists it for the curious, but it does not limit
            // the answer. A run of failures with none succeeding is different:
            // that signals the backend is down, and the budget latches
            // exploration off.
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
    if (!(yield* store.alive(fence)))
      return yield* Effect.die(new Error("Research cancelled or ownership lost"));
    if (skillTools) yield* skillTools.authorize();
    if (knowledgeTools) yield* knowledgeTools.authorize();
    if (input.finalText && synthesisLine) {
      const checked = validateResearchCitations(synthesisLine, citationIds());
      if (checked.invalid) limitations.add("Unregistered final citation references were removed.");
      yield* input.finalText!(checked.text);
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
            beforeTurnIndex: turnBase + budget.calls + 1,
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
            // Research evidence/history summaries are private execution data,
            // not activity labels. The durable compaction row retains them.
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
  const authorize = Effect.gen(function* () {
    if (!(yield* store.alive(fence)))
      return yield* Effect.die(new Error("Research cancelled or ownership lost"));
    if (skillTools) yield* skillTools.authorize();
    if (knowledgeTools) yield* knowledgeTools.authorize();
  });
  const invokeInternal = (input: {
    spec: ResearchCallSpec;
    prompt: Prompt.Prompt;
    toolkit?: Toolkit.WithHandler<any> | undefined;
    taskId?: string;
  }) =>
    input.spec.phase === "synthesis"
      ? Effect.die(new Error("Final answers require the main assistant sink"))
      : invoke(input);
  type InvestigationPhase = "coordinator" | "worker" | "report" | "compaction";
  const investigationSpec = <P extends InvestigationPhase>(phase: P) => ({
    ...specs[phase],
    phase,
  });
  const investigation = {
    store,
    fence,
    model,
    budget,
    limitations,
    tasks,
    taskSources,
    specs: {
      coordinator: investigationSpec("coordinator"),
      worker: investigationSpec("worker"),
      report: investigationSpec("report"),
      compaction: investigationSpec("compaction"),
    },
    userId: deps.userId,
    modelId: deps.modelId,
    startedAt: deps.startedAt,
    update,
    registeredSources,
    citationIds,
    manifest,
    skillContext,
    workerToolkit,
    knowledgeTools,
    knowledgeDocumentCount: deps.knowledge?.session.manifest.length ?? 0,
    compactionDepsFor,
    authorize,
    invoke: (input: {
      spec: ResearchCallSpec & { readonly phase: InvestigationPhase };
      prompt: Prompt.Prompt;
      toolkit?: Toolkit.WithHandler<any> | undefined;
      taskId?: string;
    }) =>
      ["coordinator", "worker", "report", "compaction"].includes(input.spec.phase)
        ? invokeInternal(input)
        : Effect.die(new Error("Investigation cannot execute a main assistant stage")),
  };
  return {
    investigation,
    ...investigation,
    specs,
    invokeInternal,
    // The final sink is never passed into the investigation runner.
    invokeFinal: (input: {
      prompt: Prompt.Prompt;
      toolkit?: Parameters<typeof invoke>[0]["toolkit"];
    }) => invoke({ ...input, spec: specs.synthesis, finalText: deps.text }),
  };
});

export type ResearchExecution = Effect.Success<ReturnType<typeof makeResearchExecution>>;
export type InvestigationExecution = ResearchExecution["investigation"];
