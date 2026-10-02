import { Duration, Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import type { KnowledgeService } from "~/modules/knowledge/server/service.ts";
import type { KnowledgeSearchSession } from "~/modules/knowledge/server/search.ts";
import type { AiGateway } from "~/modules/providers/server/gateway.ts";
import type { ProviderRepo } from "~/modules/providers/server/repo.ts";
import type { SkillReader } from "~/modules/skills/server/reader.ts";
import type { ToolGroup } from "~/modules/tools/server/toolset.ts";
import type { UrlReaderExecutor } from "~/modules/tools/server/url-reader.ts";
import type { WebSearchExecutor } from "~/modules/tools/server/web-search.ts";
import type { Source, ToolChunkEnvelope } from "~/modules/tools/schema.ts";
import type { CompactionChunkEnvelope } from "../../schema.ts";
import type { GenerationConfig } from "../repo.ts";
import { makeResearchExecution } from "./execution.ts";
import type { ResearchStore } from "./repo.ts";
import { runResearch } from "./runner.ts";

/**
 * Bounded enough to persist beside any other tool row: the manifest and its
 * sources, never task reports or page text.
 */
export const ResearchToolResult = Schema.Struct({
  outcome: Schema.Literals(["evidence", "no_evidence", "unavailable", "failed"]),
  runId: Schema.optionalKey(Schema.String),
  evidence: Schema.optionalKey(
    Schema.Array(Schema.Struct({ label: Schema.String, text: Schema.String })),
  ),
  limitations: Schema.optionalKey(Schema.Array(Schema.String)),
  executionBounds: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(600))),
});
export type ResearchToolResult = typeof ResearchToolResult.Type;

const researchTool = Tool.make("deep_research", {
  description:
    "Investigate a question across the web with a team of workers and return their evidence for you to answer from. Write the brief yourself: state what to find out and what would settle it, in a few sentences, since the workers never see this conversation. Use it for questions needing several sources or current information, not for something you already know or one page you could read. It returns evidence and sources, never prose: you write the answer. It cannot ask the person anything, so resolve a consequential ambiguity with ask_user before calling it. Set language to the language the person writes in (for example German): the progress they watch uses it.",
  parameters: Schema.Struct({
    brief: Schema.optionalKey(Schema.String),
    language: Schema.optionalKey(Schema.String),
  }),
  success: ResearchToolResult,
});

/** The row the stream observer minted for this call, and the ordinals it is keyed by. */
export type ToolCallRowRef = {
  readonly rowId: string;
  readonly turnIndex: number;
  readonly callIndex: number;
  /** Where in the answer's text the call was made, so its row sits there live too. */
  readonly textOffset?: number;
};

/**
 * Added to the system prompt only where the tool is offered. Without it the
 * only guidance the host has is the web hint, which tells it to search for
 * current information: the very case this tool exists for.
 */
export const RESEARCH_APP_POLICY =
  "The person turned on deep research for this message. Prefer deep_research over searching " +
  "and reading pages yourself whenever the answer needs evidence from several sources, " +
  "current information, or a comparison between them: it runs a team of investigators on " +
  "their own budget and hands back their evidence. Use web_search and read_url directly only " +
  "for a single quick fact or a page you were pointed at. The investigators never see this " +
  "conversation, so write the brief yourself: say what to find out and what would settle it. " +
  "Deciding not to call it is still yours to make, but say so rather than quietly doing a " +
  "shallower job. Answer from the evidence it returns and cite the source numbers it registers.\n" +
  "A run costs real time and money and cannot ask anything once it starts, so a brief built on a " +
  "guess wastes all of it. Where the scope is genuinely open, and the answer would differ by a lot " +
  "depending on the reading, ask_user once first: region, timeframe, depth or who it is for. Ask " +
  "only what changes the brief, and only when a sensible default would not do. Your question ends " +
  "the turn, and the answer comes back with this tool still offered.";

export interface PreparedResearchTool {
  readonly group: ToolGroup;
}

/**
 * Prepared inside `generate`, not in the handler: an investigation needs the
 * generation's gateway, providers, knowledge session and frozen config, and
 * building it needs a scope. The handler adds only what is per-call, which is
 * the run itself.
 */
export const prepareResearchTool = (input: {
  store: ResearchStore;
  gateway: AiGateway["Service"];
  providers: ProviderRepo["Service"];
  webSearch: WebSearchExecutor["Service"];
  urlReader: UrlReaderExecutor["Service"];
  userUrls: ReadonlyArray<string>;
  priorSources: ReadonlyArray<Source>;
  config: GenerationConfig;
  knowledge: { session: KnowledgeSearchSession; service: KnowledgeService["Service"] } | null;
  skillReader?: SkillReader["Service"];
  userId: string;
  conversationId: string;
  messageId: string;
  generationId: string;
  modelId: string;
  rowFor: (providerCallId: string) => Effect.Effect<ToolCallRowRef | undefined>;
  emit: (event: ToolChunkEnvelope) => Effect.Effect<void>;
  emitCompaction: (event: CompactionChunkEnvelope) => Effect.Effect<void>;
}): PreparedResearchTool => {
  const investigate = Effect.fn("research.tool")(function* (raw: unknown, providerCallId: string) {
    const brief = typeof raw === "object" && raw !== null ? (raw as { brief?: unknown }).brief : "";
    if (typeof brief !== "string" || brief.trim().length < 16)
      return {
        outcome: "failed" as const,
        message:
          "Provide a brief of a few sentences saying what to find out and what would settle it. The workers never see this conversation.",
      } satisfies ResearchToolResult;

    // The row this call already has: the observer mints it from the same
    // `tool-call` part the toolkit forked this handler on, so the wait is for
    // an ordering, not for work.
    const row = yield* input.rowFor(providerCallId);
    if (!row)
      return {
        outcome: "unavailable" as const,
        message: "The research run could not be started.",
      } satisfies ResearchToolResult;

    // Admission is one active run per person. A refusal is an answerable tool
    // result, never a failed turn.
    const queued = yield* input.store
      .queue({
        userId: input.userId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        generationId: input.generationId,
        toolCallId: row.rowId,
        modelId: input.modelId,
      })
      .pipe(
        Effect.catchTag("InvalidMessage", (error) =>
          Effect.succeed({ refused: error.reason } as const),
        ),
      );
    if (typeof queued === "object" && "refused" in queued)
      return {
        outcome: "unavailable" as const,
        message: queued.refused,
      } satisfies ResearchToolResult;

    const claim = yield* input.store.claim(queued);
    if (!claim)
      return {
        outcome: "unavailable" as const,
        message: "The research run could not be started.",
      } satisfies ResearchToolResult;

    const { fence, run } = claim;
    // The 60-second lease is renewed by whoever runs the work. On the mode path
    // that was the generation loop; here it is this handler.
    const heartbeat = input.store
      .heartbeat(fence)
      .pipe(Effect.delay(Duration.seconds(10)), Effect.forever);

    const work = Effect.gen(function* () {
      const execution = yield* makeResearchExecution({
        store: input.store,
        fence,
        gateway: input.gateway,
        providers: input.providers,
        webSearch: input.webSearch,
        urlReader: input.urlReader,
        userUrls: input.userUrls,
        priorSources: input.priorSources,
        config: input.config,
        knowledge: input.knowledge,
        ...(input.skillReader ? { skillReader: input.skillReader } : {}),
        modelId: input.modelId,
        userId: input.userId,
        call: row,
        // The call, not the queue: a tool called late in a turn must not
        // inherit an exploration window that is already half spent.
        startedAt: Date.now(),
        emit: input.emit,
        emitCompaction: input.emitCompaction,
        // The investigation is structurally barred from the answer sink
        // (`execution.ts` dies on a synthesis stage); this makes that explicit.
        text: () => Effect.die(new Error("deep_research does not write answer prose")),
        getTextOffset: () => 0,
      });
      const language =
        typeof raw === "object" && raw !== null
          ? (raw as { language?: unknown }).language
          : undefined;
      return yield* runResearch({
        brief,
        ...(typeof language === "string" ? { language } : {}),
        execution: execution.investigation,
      });
    }).pipe(Effect.scoped);

    // The heartbeat is scoped rather than raced: closing the scope interrupts
    // it *and waits for it*. Racing only signals the interrupt, so its renewal
    // transaction could still hold the conversation row when the finalize below
    // asks for it, and the turn would wait out the stream timeout.
    const result = yield* Effect.gen(function* () {
      yield* Effect.forkScoped(heartbeat);
      return yield* work.pipe(
        Effect.timeout(Duration.millis(Math.max(1, run.deadline.getTime() - Date.now()))),
        Effect.catchTag("TimeoutError", () => Effect.succeed(null)),
      );
    }).pipe(
      Effect.scoped,
      // Nothing outside this handler ends the run. On the mode path the
      // generation loop finalized it; here the handler owns the whole life of
      // the run, including an interrupt that never reaches the lines below.
      Effect.onInterrupt(() => input.store.finalize(fence.runId, "aborted", fence.owner)),
    );
    yield* input.store.finalize(
      fence.runId,
      // `no_evidence` means the investigation produced nothing usable and has
      // already recorded why; ending it as partial would hide that.
      result ? (result.outcome === "evidence" ? "complete" : "error") : "interrupted",
      fence.owner,
    );
    if (!result)
      return {
        outcome: "failed" as const,
        runId: fence.runId,
        message: "Research ran past its deadline before reaching a conclusion.",
      } satisfies ResearchToolResult;
    if (result.outcome === "no_evidence")
      return {
        outcome: "no_evidence" as const,
        runId: fence.runId,
        message: "The investigation found nothing usable.",
      } satisfies ResearchToolResult;
    return {
      outcome: "evidence" as const,
      runId: fence.runId,
      evidence: result.evidence,
      limitations: result.limitations,
      executionBounds: result.executionBounds,
    } satisfies ResearchToolResult;
  });

  return {
    group: {
      toolkit: Toolkit.make(researchTool),
      handlers: {
        deep_research: (raw: unknown, ctx: { toolCallId: string }) =>
          investigate(raw, ctx.toolCallId),
      },
    },
  };
};
