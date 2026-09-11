import { Effect } from "effect";
import type { PreparedAgentDraftTools } from "~/modules/agents/server/authoring-tools.ts";
import { AGENT_APP_POLICY } from "~/modules/agents/server/authoring-prompt.ts";
import { Prompt, Toolkit } from "effect/unstable/ai";
import type { SkillReader } from "~/modules/skills/server/reader.ts";
import type { AiGateway } from "~/modules/providers/server/gateway.ts";
import type { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { formatQuestionContext, readPresentedQuestions } from "~/modules/tools/ask-user-schema.ts";
import type { Source, ToolChunkEnvelope } from "~/modules/tools/schema.ts";
import { prepareAskUserTool } from "~/modules/tools/server/ask-user.ts";
import { extractUserMessageUrls } from "~/modules/tools/server/user-urls.ts";
import { mergeToolGroups } from "~/modules/tools/server/toolset.ts";
import type { WebSearchExecutor } from "~/modules/tools/server/web-search.ts";
import type { UrlReaderExecutor } from "~/modules/tools/server/url-reader.ts";
import { KNOWLEDGE_SYSTEM_HINT } from "~/modules/knowledge/server/context.ts";
import type { KnowledgeSearchSession } from "~/modules/knowledge/server/search.ts";
import type { KnowledgeService } from "~/modules/knowledge/server/service.ts";
import type { MemoryService } from "~/modules/memory/server/service.ts";
import { MemorySaveGuard } from "~/modules/memory/server/save-guard.ts";
import type { CompactionChunkEnvelope } from "../schema.ts";
import {
  computeBudget,
  estimatePromptTokens,
  estimateToolSchemaTokens,
  latestValidCheckpoint,
  prepareCompactedActiveRounds,
  prepareCompactedHistory,
  shrinkForOverflow,
  type ActiveRound,
  type CompactionDecision,
} from "./compaction.ts";
import { buildHistoryMessages, type PromptDeps } from "./prompt.ts";
import type { ChatRepo, MessageRow, GenerationConfig } from "./repo.ts";
import {
  type ResearchCallSpec,
  type ResearchCallPhase,
  validateResearchCitations,
} from "./research/budget.ts";
import { lockResearchFence, type ResearchFence, type ResearchStore } from "./research/repo.ts";
import * as prompts from "./research/prompts.ts";
import {
  boundEvidence,
  evidenceManifest,
  evidencePrompt,
  evidenceTokens,
  type EvidenceBlock,
} from "./research/evidence.ts";
import {
  makeResearchExecution,
  ResearchExecutionError,
  researchFailureMessage,
} from "./research/execution.ts";
import { runResearch } from "./research/runner.ts";
import { prepareConversationContext } from "./conversation-context.ts";

export const runConversationResearch = Effect.fn("chat.conversationResearch")(function* (deps: {
  memory: MemoryService["Service"];
  authoring?: PreparedAgentDraftTools;
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
  skillReader?: SkillReader["Service"];
  modelId: string;
  userId: string;
  startedAt: number;
  emit: (event: ToolChunkEnvelope) => Effect.Effect<void>;
  emitCompaction: (event: CompactionChunkEnvelope) => Effect.Effect<void>;
  text: (delta: string) => Effect.Effect<void>;
  getTextOffset: () => number;
}) {
  const { store, fence } = deps;
  const context = yield* prepareConversationContext({
    memory: deps.memory,
    userId: deps.userId,
    conversationId: fence.conversationId,
    history: deps.history,
  });
  const execution = yield* makeResearchExecution({
    store,
    fence,
    gateway: deps.gateway,
    providers: deps.providers,
    webSearch: deps.webSearch,
    urlReader: deps.urlReader,
    userUrls: extractUserMessageUrls(deps.history),
    priorSources: deps.priorSources,
    config: deps.config,
    knowledge: deps.knowledge,
    ...(deps.skillReader ? { skillReader: deps.skillReader } : {}),
    modelId: deps.modelId,
    userId: deps.userId,
    startedAt: deps.startedAt,
    emit: deps.emit,
    emitCompaction: deps.emitCompaction,
    text: deps.text,
    getTextOffset: deps.getTextOffset,
  });
  const { model, specs, budget, limitations, update, registeredSources, citationIds, authorize } =
    execution;
  const compactionDeps = execution.compactionDepsFor();
  const skillContext = (): Prompt.MessageEncoded[] => [
    ...(deps.authoring?.messages() ?? []),
    ...execution.skillContext(),
    deps.runtimeContext,
  ];
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
    deferAssistantBytes: true,
    messages: history,
    webToolsEnabled: true,
    modelSupportsFiles: model?.capabilities.files ?? false,
  });
  const historyGroups: Array<ReadonlyArray<Prompt.MessageEncoded>> = [];
  const retainedHistory = new Map<number, ReadonlyArray<Prompt.MessageEncoded>>();
  const loadedBytes = new Map<string, Uint8Array>();
  const replayInput = {
    webToolsEnabled: true,
    modelSupportsFiles: model?.capabilities.files ?? false,
    modelSupportsVision: model?.capabilities.vision ?? false,
    expandAssistantTurns: true,
    ...(model ? { modelIdentity: { providerId: model.providerId, modelKey: model.modelKey } } : {}),
  };
  for (let index = 0; index < history.length; index++) {
    const message = history[index]!;
    historyGroups.push(
      message.assistantOutput?.images.length || message.providerReplay?.turns.length
        ? yield* buildHistoryMessages(
            { ...deps.promptDeps, chat: deps.repo },
            { ...replayInput, messages: [message], deferAssistantBytes: true },
          )
        : [rendered[index]!],
    );
  }
  // Agent instructions are user-level configuration: a separate, lower-authority
  // message after the application policy, never merged into it.
  const agentInstructions: Prompt.MessageEncoded[] = deps.config.resolvedAgent?.instructions.trim()
    ? [
        {
          role: "user",
          content: `<agent-instructions name=${JSON.stringify(deps.config.resolvedAgent.name)}>\n${deps.config.resolvedAgent.instructions}\n</agent-instructions>`,
        },
      ]
    : [];
  const knowledgePolicy: Prompt.MessageEncoded[] = deps.knowledge
    ? [{ role: "system", content: KNOWLEDGE_SYSTEM_HINT }]
    : [];
  const fixedPrefixFor = (phase: ResearchCallPhase): Prompt.MessageEncoded[] => [
    { role: "system", content: prompts.assistantPolicy },
    { role: "system", content: AGENT_APP_POLICY },
    ...knowledgePolicy,
    ...context.messages(
      phase === "planning" && context.memoryTools !== undefined && !context.memoryTools.attempted(),
    ),
    ...agentInstructions,
  ];
  let historyProjection:
    | Pick<CompactionDecision, "startIndex" | "injectedMessages" | "checkpoint">
    | undefined;
  let evidenceSummary: string | null = null;
  let evidenceRounds: ReadonlyArray<ActiveRound> = [];
  const evidenceBlocks = new Map<number, EvidenceBlock>();
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
    continuation?: Prompt.Prompt,
    toolkit?: Pick<Toolkit.Any, "tools">,
  ) {
    const toolSchemaTokens = estimateToolSchemaTokens(toolkit);
    const fixedPrefix = fixedPrefixFor(spec.phase);
    const usesEvidence = spec.phase === "synthesis";
    const request: Prompt.MessageEncoded = {
      role: "user",
      content: [prompts.stageRequest, data, notice].filter(Boolean).join("\n"),
    };
    const stagePrefix: Prompt.MessageEncoded[] = [
      ...skillContext(),
      { role: "system", content: policy },
      ...((continuation?.content ?? []) as ReadonlyArray<Prompt.MessageEncoded>),
    ];
    const inputBudget = computeBudget({
      contextLength: model?.contextLength,
      outputReserve: spec.maxOutputTokens,
      toolSchemaTokens,
      webToolsEnabled:
        spec.phase === "planning" || spec.phase === "clarification" || !!deps.authoring,
    }).input;
    const protectedIndex = Math.max(
      0,
      (protectedStart ?? deps.history.map((message) => message.role).lastIndexOf("user")) - offset,
    );
    const protectedTokens = estimatePromptTokens([
      ...fixedPrefix,
      ...historyGroups.slice(protectedIndex).flat(),
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
      toolSchemaTokens,
      existingCheckpoint: selected?.checkpoint ?? null,
      ...(historyProjection ? { projection: historyProjection } : {}),
      messages: history,
      renderedMessages: rendered,
      renderedMessageGroups: historyGroups,
      fixedPrefix,
      trailingMessages,
      webToolsEnabled:
        spec.phase === "planning" || spec.phase === "clarification" || !!deps.authoring,
      maxStartIndex: protectedIndex,
    });
    historyProjection = decision;
    for (let index = decision.startIndex; index < history.length; index++) {
      if (retainedHistory.has(index)) continue;
      const message = history[index]!;
      retainedHistory.set(
        index,
        message.assistantOutput?.images.length || message.providerReplay?.turns.length
          ? yield* buildHistoryMessages(
              { ...deps.promptDeps, chat: deps.repo },
              { ...replayInput, messages: [message], loadedBytes },
            )
          : [rendered[index]!],
      );
    }
    const baseMessages = [
      ...fixedPrefix,
      ...decision.injectedMessages,
      ...rendered
        .slice(decision.startIndex)
        .flatMap((message, index) => retainedHistory.get(index + decision.startIndex) ?? [message]),
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
        toolSchemaTokens,
        webToolsEnabled: toolkit !== undefined,
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
        ...rendered
          .slice(value.startIndex)
          .flatMap((message, index) => retainedHistory.get(index + value.startIndex) ?? [message]),
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
          renderedMessageGroups: historyGroups,
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
    continuation?: Prompt.Prompt;
  }) {
    if (deps.authoring) yield* deps.authoring.refresh();
    const prepared = yield* stage(
      specs[input.phase],
      input.policy,
      input.data,
      input.notice,
      input.continuation,
      input.toolkit,
    );
    const invoke = (value: { prompt: Prompt.Prompt }) =>
      input.phase === "synthesis"
        ? execution.invokeFinal({ ...value, ...(input.toolkit ? { toolkit: input.toolkit } : {}) })
        : execution.invokeInternal({
            ...value,
            spec: specs[input.phase],
            ...(input.toolkit ? { toolkit: input.toolkit } : {}),
          });
    const beforeCall = deps.getTextOffset();
    return yield* invoke({ prompt: prepared.prompt }).pipe(
      Effect.catchTag("ProviderContextOverflow", (error) => {
        // A rejected preflight can be repaired; an answer already being read
        // cannot be restarted and appended a second time. It ends partial.
        if (input.phase === "synthesis" && deps.getTextOffset() !== beforeCall)
          return Effect.fail(error);
        const repaired = prepared.repair();
        if (!repaired) return Effect.fail(error);
        limitations.add(
          "Earlier conversational context was reduced after a provider context rejection.",
        );
        return invoke({ prompt: repaired });
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
  const prepare = Effect.gen(function* () {
    // Toolkit captures its handler context when merged, so construct it under
    // the same transactional memory guard as its later execution.
    const memoryToolkit = context.memoryTools
      ? yield* mergeToolGroups([context.memoryTools.group])
      : undefined;
    const first = yield* invokeStage({
      phase: "planning",
      policy: prompts.planningPolicy,
      toolkit: memoryToolkit,
    });
    if (first.finishReason !== "tool-calls") return first;
    // Exactly one accounted, tool-free continuation. Even a malformed save
    // consumes the handler's single attempt; no recursive preparation loop.
    return yield* invokeStage({
      phase: "planning",
      policy: prompts.planningPolicy,
      continuation: Prompt.fromResponseParts(first.parts),
      notice:
        "The memory save attempt is finished. No tools are available. Now write the self-contained research brief as text only.",
    });
  });
  const plan = yield* prepare.pipe(
    Effect.provideService(MemorySaveGuard, (tx) => lockResearchFence(tx, fence)),
  );
  if (!plan.text.trim())
    return yield* Effect.die(new Error("The main assistant returned no research brief"));
  yield* authorize;
  // Selecting research is the dispatch decision. No model tool call can opt
  // out or produce an unsupported shortcut answer instead of investigation.
  const investigation = yield* runResearch({
    brief: plan.text,
    execution: execution.investigation,
  });
  if (investigation.outcome === "no_evidence") return "error" as const;
  yield* authorize;
  for (const block of investigation.evidence) appendEvidence(block);
  yield* update("synthesizing");
  const beforeSynthesis = deps.getTextOffset();
  const final = yield* Effect.gen(function* () {
    const toolkit = deps.authoring ? yield* mergeToolGroups([deps.authoring.group]) : undefined;
    let continuation = Prompt.empty;
    let text = "";
    // Every round uses the same accounted final sink, budget, deadline and fence.
    // The last pass is tool-free, like the ordinary conversation loop.
    for (let round = 0; round <= 4; round++) {
      const result = yield* invokeStage({
        phase: "synthesis",
        policy: prompts.synthesisPolicy,
        toolkit: round < 4 ? toolkit : undefined,
        continuation,
        ...(round > 0
          ? {
              notice:
                "Continue after the tool results. Do not repeat any answer text already emitted. The current agent draft is in the application data.",
            }
          : {}),
        data: `Limitations:\n${investigation.limitations.join("\n")}\nExecution bounds:\n${investigation.executionBounds}`,
      });
      text += result.text;
      if (result.finishReason !== "tool-calls") return { text };
      continuation = Prompt.concat(continuation, Prompt.fromResponseParts(result.parts));
    }
    return yield* Effect.die(new Error("The assistant did not finish after updating the draft."));
  }).pipe(
    // Synthesis emits validated lines as they arrive. Once the reader has an
    // answer on screen, a failure on the way to the finish part is a truncated
    // report, not a failed run — discarding it would delete what they can read.
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        if (!(yield* store.alive(fence)) || deps.getTextOffset() === beforeSynthesis)
          return yield* Effect.failCause(cause);
        limitations.add(researchFailureMessage(cause));
        yield* authorize;
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
