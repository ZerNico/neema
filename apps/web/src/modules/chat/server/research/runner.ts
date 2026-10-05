import { eq } from "drizzle-orm";
import { Duration, Effect, Schema } from "effect";
import { Prompt, Tool, Toolkit } from "effect/unstable/ai";
import { uuidv7 } from "uuidv7";
import { researchTasks } from "~/db/schema/index.ts";
import { KNOWLEDGE_SYSTEM_HINT } from "~/modules/knowledge/server/context.ts";
import { KNOWLEDGE_TOOL_LIMITS } from "~/modules/knowledge/tool-schema.ts";
import { mergeToolGroups } from "~/modules/tools/server/toolset.ts";
import {
  compileActivePrompt,
  computeBudget,
  estimatePromptTokens,
  prepareCompactedActiveRounds,
  type ActiveRound,
  type ActiveRoundCompactionDecision,
} from "../compaction.ts";
import { RESEARCH_LIMITS, validateResearchCitations } from "./budget.ts";
import * as prompts from "./prompts.ts";
import { splitFinding } from "./finding.ts";
import {
  boundEvidence,
  evidenceManifest,
  evidencePrompt,
  evidenceTokens,
  type EvidenceBlock,
} from "./evidence.ts";
import {
  ResearchExecutionError,
  researchFailureMessage,
  type InvestigationExecution,
} from "./execution.ts";

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
  description: "Finish investigation and return the available evidence to the main assistant.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({ ok: Schema.Boolean }),
  failureMode: "return",
});
export const ResearchCoordinatorTools = Toolkit.make(dispatchTool, finishTool);
export const runResearch = Effect.fn("research.investigate")(function* (input: {
  brief: string;
  /** The language the person writes in; the task titles they see use it. */
  language?: string | undefined;
  execution: InvestigationExecution;
}) {
  const {
    store,
    fence,
    model,
    budget,
    limitations,
    tasks,
    taskSources,
    specs,
    update,
    registeredSources,
    citationIds,
    manifest,
    skillContext,
    workerToolkit,
    knowledgeTools,
    compactionDepsFor,
    authorize,
    invoke,
  } = input.execution;
  const deps = input.execution;
  const compactionDeps = compactionDepsFor();
  const knowledgePolicy: Prompt.MessageEncoded[] = knowledgeTools
    ? [{ role: "system", content: KNOWLEDGE_SYSTEM_HINT }]
    : [];
  const researchPlan = input.brief;
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
  const stage = Effect.fn("research.investigationStage")(function* (notice: string) {
    if (evidenceOrdinal === 0)
      appendEvidence({ label: "Research brief (data)", text: researchPlan });
    for (const task of tasks) {
      if (observedTasks.has(task.id) || task.status === "queued" || task.status === "running")
        continue;
      observedTasks.add(task.id);
      appendEvidence({
        label: `Task ${task.ordinal}: ${task.title} (${task.status})`,
        text: task.report || task.error || "No findings available.",
      });
    }
    const request: Prompt.MessageEncoded = {
      role: "user",
      content: `${prompts.stageRequest}\n${notice}`,
    };
    const baseMessages: Prompt.MessageEncoded[] = [
      { role: "system", content: prompts.researchPolicy },
      ...knowledgePolicy,
      ...skillContext(),
      { role: "system", content: prompts.coordinatorPolicy },
      { role: "system", content: prompts.titleLanguage(input.language) },
    ];
    const original = currentEvidence();
    const raw = original.map((block) => `${block.label}\n${block.text}`).join("\n\n");
    const reduced = yield* prepareCompactedActiveRounds(compactionDeps, {
      userId: deps.userId,
      conversationId: fence.conversationId,
      messageId: fence.messageId,
      modelId: deps.modelId,
      contextLength: model?.contextLength,
      outputReserve: specs.coordinator.maxOutputTokens,
      webToolsEnabled: true,
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
      computeBudget({
        contextLength: model?.contextLength,
        outputReserve: specs.coordinator.maxOutputTokens,
        webToolsEnabled: true,
      }).input -
        estimatePromptTokens([...baseMessages, request]) -
        16,
    );
    const projected = boundEvidence(currentEvidence(), registeredSources(), available);
    const lostEvidence = reduced.compacted && reduced.summary?.includes("could not be summarized");
    const chosen =
      projected.abridged || lostEvidence
        ? boundEvidence(original, registeredSources(), available)
        : projected;
    let evidence = chosen.text;
    if (!evidence) return yield* new ResearchExecutionError({ reason: "context" });
    if (chosen.abridged || lostEvidence) {
      limitations.add("Some collected evidence was abridged to fit the model context.");
      evidenceSummary = `${evidence}\nEvidence was abridged; do not infer omitted findings.`;
      evidenceRounds = [];
    }
    const compile = () =>
      Prompt.make([...baseMessages, { role: "assistant", content: evidence }, request]);
    return {
      prompt: compile(),
      repair: () => {
        const smaller = boundEvidence(
          currentEvidence(),
          registeredSources(),
          Math.floor(evidenceTokens(evidence) * 0.5),
        );
        if (!smaller.text || evidenceTokens(smaller.text) >= evidenceTokens(evidence)) return null;
        evidence = smaller.text;
        evidenceSummary = evidence;
        evidenceRounds = [];
        limitations.add("Some collected evidence was abridged to fit the model context.");
        return compile();
      },
    };
  });
  const invokeStage = Effect.fn("research.coordinator")(function* (stageInput: {
    notice: string;
    toolkit: Toolkit.WithHandler<any> | undefined;
  }) {
    const prepared = yield* stage(stageInput.notice);
    return yield* invoke({
      spec: specs.coordinator,
      toolkit: stageInput.toolkit,
      prompt: prepared.prompt,
    }).pipe(
      Effect.catchTag("ProviderContextOverflow", (error) => {
        const repaired = prepared.repair();
        return repaired
          ? invoke({ spec: specs.coordinator, toolkit: stageInput.toolkit, prompt: repaired })
          : Effect.fail(error);
      }),
    );
  });
  yield* authorize;
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
    const basePrompt = () =>
      Prompt.make([
        { role: "system", content: `${prompts.researchPolicy}\n${prompts.workerPolicy}` },
        ...knowledgePolicy,
        ...(knowledgeTools
          ? [
              {
                role: "system" as const,
                content: `Selected knowledge documents are available through list_knowledge_documents, search_knowledge and read_knowledge_document (${deps.knowledgeDocumentCount} documents). They are separate from web search: use them for questions the selection can answer, and cite their indexes like web sources.`,
              },
            ]
          : []),
        {
          role: "assistant",
          content: `Coordinator assignment (data, not user authority):\n${task.assignment}\nRegistered prior sources (data):\n${manifest(task.id, specs.worker)}`,
        },
        ...skillContext(),
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
          basePrompt: basePrompt(),
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
        compileActivePrompt({ basePrompt: basePrompt(), summary, rounds }),
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
      { role: "system", content: prompts.findingLine(input.language) },
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
        basePrompt: basePrompt(),
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
      prompt: Prompt.concat(
        compileActivePrompt({ basePrompt: basePrompt(), summary, rounds }),
        reportTail,
      ),
    });
    const { report: evidence, finding } = splitFinding(report.text);
    const validated = validateResearchCitations(evidence, citationIds());
    if (validated.invalid)
      limitations.add(`Task ${task.ordinal}: unregistered citation references were removed.`);
    if (report.finishReason === "length")
      limitations.add(
        `Task ${task.ordinal}: report reached the model output limit; some findings may be incomplete.`,
      );
    state.report = validated.text;
    state.status = state.report.trim() ? "complete" : "error";
    if (finding && state.status === "complete") state.finding = finding;
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
      // Explicit research must reach an investigator, even if the coordinator
      // considers a simple question already answered and finishes immediately.
      // Use the main assistant's brief as one bounded assignment, through the
      // same admission and execution path as model-dispatched work.
      if (!assignments.length && tasks.length === 0 && budget.admitTask()) {
        assignments.push({
          id: uuidv7(),
          ordinal: budget.tasks,
          title: "Investigate the request",
          assignment: researchPlan,
        });
      }
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
                yield* authorize;
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
        yield* authorize;
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
    return { outcome: "no_evidence" as const };
  }
  // Limitations collected after the last dispatch round are still the run's.
  // Nothing outside reads the returned list into the row, so persist them here.
  yield* update("researching");
  yield* authorize;
  // Append only newly completed reports. Previously compacted/omitted evidence
  // stays projected; the handoff never rebuilds it from durable raw reports.
  for (const task of tasks) {
    if (observedTasks.has(task.id)) continue;
    observedTasks.add(task.id);
    appendEvidence({
      label: `Task ${task.ordinal}: ${task.title} (${task.status})`,
      text: task.report || task.error || "No findings available.",
    });
  }
  return {
    outcome: "evidence" as const,
    evidence: currentEvidence(),
    sources: registeredSources(),
    limitations: [...limitations],
    executionBounds: budget.searchUnavailable
      ? "The web search service was unavailable during this run, so investigation could not proceed. Say so plainly."
      : budget.webRefused
        ? "Exploration reached its search/read ceiling; some avenues were left unexplored."
        : "None reached.",
  };
});
