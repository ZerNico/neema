import type { ExternalOwner } from "~/modules/tools/server/external-completion.ts";
import { DESKTOP_TIMEOUTS, approvalKind } from "~/modules/desktop/tool-schema.ts";
import { AgentDraftService } from "~/modules/agents/server/draft-service.ts";
import { DocumentService } from "~/modules/documents/server/document-service.ts";
import { prepareDocumentTools } from "~/modules/documents/server/document-tools.ts";
import {
  ProjectFileToolName,
  projectFileFailureReason,
  projectFileResultOk,
  projectProjectFileResult,
} from "~/modules/projects/file-tool-schema.ts";
import { projectCan } from "~/modules/projects/schema.ts";
import { prepareProjectFileTools } from "~/modules/projects/server/file-tools.ts";
import { ProjectFileService } from "~/modules/projects/server/project-files.ts";
import { ProjectMemoryService } from "~/modules/projects/server/project-memory.ts";
import { prepareResearchTool, ResearchToolResult, type ToolCallRowRef } from "./research/tool.ts";

import {
  DocumentToolName,
  documentFailureReason,
  projectDocumentResult,
  documentResultOk,
  redactDocumentPart,
} from "~/modules/documents/tool-schema.ts";
import { prepareAgentDraftTools } from "~/modules/agents/server/authoring-tools.ts";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import {
  AgentDraftToolName,
  agentDraftFailureReason,
  projectAgentDraftResult,
  agentDraftResultOk,
  redactAgentDraftPart,
} from "~/modules/agents/tool-schema.ts";
import { prepareScheduleDraftTools } from "~/modules/schedules/server/authoring-tools.ts";
import { ScheduleDraftService } from "~/modules/schedules/server/draft-service.ts";
import {
  ScheduleDraftToolName,
  projectScheduleDraftResult,
  redactScheduleDraftPart,
  scheduleDraftFailureReason,
  scheduleDraftResultOk,
} from "~/modules/schedules/tool-schema.ts";
import { KnowledgeRepo } from "~/modules/knowledge/server/repo.ts";
import { SkillRepo } from "~/modules/skills/server/repo.ts";
import { SkillReader } from "~/modules/skills/server/reader.ts";
import { SKILL_LIMITS } from "~/modules/skills/package.ts";
import { earlierSkillMessage, prepareSkillTools } from "~/modules/skills/server/tools.ts";
import { SkillToolName, projectSkillToolResult } from "~/modules/skills/tool-schema.ts";
import { PresentationFonts } from "~/modules/presentations/server/fonts.ts";
import type { FontFace } from "~/modules/presentations/server/font-file.ts";
import { sha256Hex } from "~/modules/attachments/server/sha256.ts";
import { ToolsRepo } from "~/modules/tools/server/repo.ts";
import {
  isOfficeFamily,
  OFFICE_FAMILIES,
  officeFamilyOfEdit,
  officeFamilyOfFile,
  officeFamilyOfTool,
} from "~/modules/office/families.ts";
import {
  officeProcessors,
  prepareOfficeTools,
  runnableOfficeFamilies,
} from "~/modules/office/server/families.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { attachmentKind } from "~/modules/attachments/constants.ts";
import { acceptGeneratedFile, acceptGeneratedImage } from "./generated-files.ts";
import { fileForModel } from "./file-for-model.ts";
import { attachmentReferenceHint } from "../file-references.ts";
import {
  ensureGenerationLive,
  GenerationFence,
  GenerationSettled,
  lockGeneration,
  type GenerationIdentity,
} from "./generation-fence.ts";
import { boundedReplay, replayDetails, type ProviderReplay } from "./provider-replay.ts";
import { responseTurnPrompt } from "~/modules/providers/server/response-prompt.ts";
import { prepareConversationContext } from "./conversation-context.ts";
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
  type Scope,
} from "effect";
import {
  AskUserParams,
  AskUserResult,
  formatQuestionContext,
  readPresentedQuestions,
} from "~/modules/tools/ask-user-schema.ts";
import { prepareAskUserTool } from "~/modules/tools/server/ask-user.ts";
import { prepareDesktopTools } from "~/modules/desktop/server/tools.ts";
import { preparePlanTool } from "~/modules/tools/server/plan-tool.ts";
import { PlanSnapshot, PlanToolResult, renderPlanReminder } from "~/modules/tools/plan-schema.ts";
import { Prompt, type Response } from "effect/unstable/ai";
import { uuidv7 } from "uuidv7";
import { AnalyticsRepo } from "~/modules/analytics/server/repo.ts";
import { addFinishUsage, emptyUsageTotals, resolveCost } from "~/modules/analytics/server/usage.ts";
import { BlobStore } from "~/modules/attachments/server/blob-store.ts";
import { Db } from "~/server/db.ts";
import { makeToolFileResolver } from "./tool-files.ts";
import { createWorkingFiles, type WorkingFiles } from "./working-files.ts";
import { KeptWorkingFiles } from "./kept-working-files.ts";
import { formatFileRef, parseFileRef } from "./file-ref.ts";
import { preparePublishFileTool } from "./publish-file.ts";
import { ToolFileActivity } from "../tool-file-schema.ts";
import { DocumentParser } from "~/modules/attachments/server/document-parser.ts";
import { AttachmentRepo, toAttachmentDto, type DbTx } from "~/modules/attachments/server/repo.ts";
import {
  AiGateway,
  ProviderContextOverflow,
  anchorLastMessage,
  cacheAnchor,
} from "~/modules/providers/server/gateway.ts";
import { SaveMemoryResult } from "~/modules/memory/server/memory-tool.ts";
import { MemoryService } from "~/modules/memory/server/service.ts";
import {
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
import { customToolName } from "~/modules/custom-tools/schema.ts";
import { projectCustomToolResult } from "~/modules/custom-tools/tool-schema.ts";
import { findIntegration } from "~/modules/integrations/catalog.ts";
import { IntegrationApprovals } from "~/modules/integrations/server/approvals.ts";
import { IntegrationService } from "~/modules/integrations/server/service.ts";
import { prepareIntegrationTools } from "~/modules/integrations/server/tools.ts";
import { projectIntegrationToolResult } from "~/modules/integrations/tool-schema.ts";
import { CustomToolRepo } from "~/modules/custom-tools/server/repo.ts";
import { CustomToolRuntime } from "~/modules/custom-tools/server/runtime.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { prepareCustomTools } from "~/modules/custom-tools/server/tools.ts";
import { createSourceIndexer } from "~/modules/tools/server/source-indexer.ts";
import { mergeToolGroups, prepareWebTools } from "~/modules/tools/server/toolset.ts";
import { createUrlAuthority } from "~/modules/tools/server/url-authority.ts";
import { prepareBrowserTools } from "~/modules/browser/server/tools.ts";
import { isBrowserTool, shownBrowserArgs } from "~/modules/browser/tool-schema.ts";
import { UrlReaderExecutor } from "~/modules/tools/server/url-reader.ts";
import { extractUserMessageUrls } from "~/modules/tools/server/user-urls.ts";
import { WebSearchExecutor } from "~/modules/tools/server/web-search.ts";
import { isWebSource, sourceTarget, mergeSource, mergeSources } from "~/modules/tools/sources.ts";
import type { Source, ToolChunkEnvelope, WebToolResult } from "~/modules/tools/schema.ts";
import { ExternalCompletion } from "~/modules/tools/server/external-completion.ts";
import {
  DesktopToolName,
  DesktopToolResult,
  forTranscript,
} from "~/modules/desktop/tool-schema.ts";
import type { CompactionChunkEnvelope, SteerChunkEnvelope } from "../schema.ts";
import {
  calibrationFactor,
  compileActivePrompt,
  computeBudget,
  estimatePromptTokens,
  estimateToolSchemaTokens,
  ContextTooLarge,
  latestValidCheckpoint,
  prepareCompactedActiveRounds,
  prepareCompactedHistory,
  shrinkForOverflow,
  summaryTokensFor,
  type ActiveRound,
  type ActiveRoundCompactionDecision,
  type CompactionDecision,
} from "./compaction.ts";
import {
  buildHistoryMessages,
  loadResumedImages,
  RESUME_REMINDER,
  inlineTextCharsFor,
  resumeFirstTurn,
  resumedRounds,
  type HistorySteer,
  type PromptDeps,
} from "./prompt.ts";
import { RESEARCH_TURN_BASE } from "./research/execution.ts";
import { buildFixedPrefix } from "./system-prompt.ts";
import { attachmentReadActivity, prepareAttachmentReader } from "./attachment-reader.ts";
import { hasFileText } from "~/modules/attachments/server/file-text.ts";
import {
  isAdvertised,
  lazyFamilyOfTool,
  prepareToolLoad,
} from "~/modules/tools/server/tool-load.ts";
import { LazyToolFamily, LoadToolsResult } from "~/modules/tools/tool-load-schema.ts";

import { runtimeContextMessage } from "./runtime-context.ts";
import { buildSearchReminder, MAX_PRIOR_SOURCES, systemReminderMessage } from "./search-prompt.ts";
import { ChatRepo, type ChunkKind } from "./repo.ts";
import type { JsonValue } from "~/db/schema/providers.ts";

/** Faces one answer's loaded skills may add to its previews. */
const SKILL_FONT_FACES = 24;

/**
 * Live chunk events fanned out to SSE subscribers on this instance.
 * Replay across instances/reloads always comes from Postgres, so this PubSub
 * only needs to carry chunks for in-flight generations.
 */
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
// model → tool_calls → execute → feed results back → model continues. One
// ceiling for every chat: a runaway loop, not a budget. Per-tool budgets and
// the tools-off final pass still apply.
const MAX_TOOL_ROUNDS = 128;
/** A file name inside a policy or reminder block is data: quoted, and unable to close the block. */
const quotedName = (name: string) => JSON.stringify(name.replace(/[<>]/g, ""));
/** Slide images one answer may put in front of the model, which it pays for per round. */
const PREVIEW_FEEDBACK_LIMITS = { slides: 256, bytes: 128 * 1024 * 1024 } as const;

// Projected activities are literal structs; one widening at the boundary
// beats an assertion chain at every persistence site.
/**
 * Schema-validated tool output is plain JSON at runtime, but readonly arrays
 * and optional keys keep TS from proving that against the recursive JsonValue
 * type. Stated here once rather than at every row that stores a result.
 */
const json = (value: unknown) => value as JsonValue;

/**
 * The first line of a machine tool's result that returned a file: its
 * reference, and whether the user sees it. Only a shared screenshot or a
 * published file ever reaches them.
 */
const returnedLine = (
  name: string,
  reference: string,
  shared: { readonly attachment: unknown } | { readonly reason: string } | null,
) => {
  if (name !== "browser_snapshot")
    return `Returned file ${reference}: for other tools, or publish_file to give it to the user, who cannot see it otherwise.`;
  if (shared === null)
    return `Screenshot ${reference}: only you see it. To show the user, take it with share.`;
  return "attachment" in shared
    ? `Screenshot ${reference}: shared with the user, attached to your answer.`
    : `Screenshot ${reference}: it could not be shared (${shared.reason}); only you see it.`;
};
/** Same boundary for a decoded Prompt: its content is already message-shaped. */
const promptMessages = (prompt: { content: unknown }) =>
  prompt.content as ReadonlyArray<Prompt.MessageEncoded>;

// Message and tool-call rows are shipped to the client wholesale, so the
// stored error must not carry provider stack traces or internal URLs. The
// full cause goes to the server log instead (see finalize).
const shortErrorMessage = (error: unknown): string =>
  String(error).split("\n", 1)[0]!.slice(0, 200);

/**
 * Runs assistant generations detached from any HTTP request, persists chunks
 * for resumability, and republishes them for live subscribers.
 */
export class StreamEngine extends Context.Service<
  StreamEngine,
  {
    /**
     * Fire-and-forget: start generating the assistant message. Returns once
     * the generation fiber is forked (not when it finishes).
     */
    startGeneration(input: {
      userId: string;
      conversationId: string;
      messageId: string;
      modelId: string;
      searchEnabled: boolean;
      generationId?: string | undefined;
      desktopExecutorId?: string | undefined;
      /**
       * The folders the sending machine named, paths included. Never stored:
       * the paths exist for this attempt's prompt and tool traffic alone.
       */
      desktopFolders?: ReadonlyArray<{ name: string; path: string }> | undefined;
      /** See `ExternalOwner.deviceSessionId`; taken from the session, not the body. */
      deviceSessionId?: string | undefined;
      timeZone?: string | undefined;
      /** The document open in the panel, so it is the one the model reads first. */
      openDocumentId?: string | undefined;
      /** Continue the answer from its stored rounds instead of starting it over. */
      resume?: boolean | undefined;
      /**
       * Invoked inside the generation fiber once it reaches a terminal status.
       * The engine cannot reach the chat service, so queue dispatch arrives
       * this way rather than through a layer cycle.
       */
      onSettled?: (input: {
        userId: string;
        conversationId: string;
        messageId: string;
        status: "complete" | "error" | "aborted";
      }) => Effect.Effect<void>;
    }): Effect.Effect<void>;
    /**
     * Winds a running generation down early, keeping whatever it has already
     * produced. False when this instance is not the one running it, the same
     * single-instance constraint the live chunk tail has (replay is durable,
     * the in-flight fiber is not).
     */
    stopGeneration(messageId: string, expectedRunId?: string): Effect.Effect<boolean>;
    /**
     * Waits until this instance's attempt has finalized: persisted, announced
     * and settled. Returns at once when it is not running here.
     */
    awaitSettled(messageId: string, expectedRunId?: string): Effect.Effect<void>;
    /**
     * Settles ordinary generations whose lease lapsed (their process is gone)
     * and notifies subscribers. Runs on a timer; callers may run it on demand.
     */
    reapOrphans: Effect.Effect<void>;
    /**
     * Chunks already persisted after `afterSeq`, then live chunks, then done.
     * Terminates when the message reaches a terminal status.
     */
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
      const external = yield* ExternalCompletion;
      const gateway = yield* AiGateway;
      const sync = yield* SyncBus;
      const webSearch = yield* WebSearchExecutor;
      const urlReader = yield* UrlReaderExecutor;
      const providers = yield* ProviderRepo;
      const authoringServices = {
        agents: yield* AgentRepo,
        providers,
        drafts: yield* AgentDraftService,
        skills: yield* SkillRepo,
        knowledge: yield* KnowledgeRepo,
      };
      const scheduleAuthoringServices = {
        providers,
        drafts: yield* ScheduleDraftService,
      };
      const documentService = yield* DocumentService;
      const analytics = yield* AnalyticsRepo;
      const memory = yield* MemoryService;
      const projectMemory = yield* ProjectMemoryService;
      const knowledgeSearch = yield* KnowledgeSearch;
      const knowledgeService = yield* KnowledgeService;
      const skillReader = yield* SkillReader;
      const customToolRuntime = yield* CustomToolRuntime;
      const customToolRepo = yield* CustomToolRepo;
      const processors = yield* officeProcessors;
      const presentationFonts = yield* Effect.serviceOption(PresentationFonts);
      const toolRegistry = yield* Effect.serviceOption(ToolsRepo);
      const policy = yield* FeaturePolicy;
      const integrations = yield* IntegrationService;
      const integrationApprovals = yield* IntegrationApprovals;
      const attachments = yield* AttachmentRepo;
      const promptDeps: PromptDeps = {
        attachments,
        store: yield* BlobStore,
        parser: yield* DocumentParser,
      };
      // Sliding, not unbounded: a subscriber that stops reading (stalled SSE
      // connection) must not buffer every in-flight generation's chunks
      // forever. Dropped events are recoverable: resume replays from
      // Postgres by seq, and `done` re-syncs the final row.
      const pubsub = yield* PubSub.sliding<StreamEvent>(4096);
      const imageAttachments = yield* Effect.serviceOption(AttachmentService);
      // Optional so test engines need not build blob storage for it.
      const projectFiles = yield* Effect.serviceOption(ProjectFileService);
      // Optional for the same reason; without it a tool's file parameter
      // simply finds no files.
      const database = yield* Effect.serviceOption(Db);
      // Unpublished working files outlive their answer only where storage
      // exists; test engines without it keep none.
      const keptFiles = Option.getOrUndefined(yield* Effect.serviceOption(KeptWorkingFiles));

      // messageId -> the deferred its generation races against. Completing it
      // is how "stop" works: the fiber winds itself down and still runs
      // finalize, so the partial answer is persisted and every subscriber
      // gets a `done`. Interrupting the fiber from outside would skip both.
      const inFlight = new Map<
        string,
        {
          abort: Deferred.Deferred<void>;
          /** Completed once finalize has run, for a caller that must wait it out. */
          settled: Deferred.Deferred<void>;
          runId?: string | undefined;
          owner: ExternalOwner | null;
        }
      >();
      const runtimeScope = yield* Effect.scope;
      // A generation whose process died stays "streaming" forever unless
      // someone settles it: the client cannot stop it (nothing is registered
      // here) and cannot send (the conversation is busy). Settle it from the
      // database clock and tell subscribers, exactly as a crash-time finalize
      // would have.
      const reapGenerations = repo.reapExpiredGenerations().pipe(
        Effect.flatMap((settled) =>
          Effect.forEach(
            settled,
            (row) =>
              PubSub.publish(pubsub, {
                kind: "done",
                messageId: row.messageId,
                ...(row.generationId ? { runId: row.generationId } : {}),
                status: "error",
              }).pipe(
                Effect.andThen(
                  sync.publish(row.userId, {
                    type: "message.status",
                    conversationId: row.conversationId,
                    messageId: row.messageId,
                    status: "error",
                  }),
                ),
              ),
            { discard: true },
          ),
        ),
        Effect.catchCause((cause) => Effect.logError("generation reconciliation failed", cause)),
      );
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          if (repo.research)
            yield* repo.research
              .reap()
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("research reconciliation failed", cause),
                ),
              );
          yield* reapGenerations;
          for (const owner of yield* external.owners()) {
            if (!(yield* repo.isDesktopAttemptLive(owner))) yield* external.cancelAttempt(owner);
          }
        }).pipe(Effect.delay(Duration.seconds(10)), Effect.forever),
      );

      const runGeneration = Effect.fn("StreamEngine.runGeneration")(function* (input: {
        userId: string;
        conversationId: string;
        messageId: string;
        modelId: string;
        searchEnabled: boolean;
        generationId?: string | undefined;
        desktopExecutorId?: string | undefined;
        desktopFolders?: ReadonlyArray<{ name: string; path: string }> | undefined;
        deviceSessionId?: string | undefined;
        timeZone?: string | undefined;
        openDocumentId?: string | undefined;
        resume?: boolean | undefined;
        abort: Deferred.Deferred<void>;
      }) {
        const fence = yield* GenerationFence;
        const currentMessage = yield* repo.getMessage(input.messageId);
        if (fence && currentMessage?.generationId !== fence.generationId) return;
        // The frozen configuration this answer runs with. Dispatch consumes it
        // read-only: identity is decided at turn time, access is rechecked here.
        const config = yield* repo.getGenerationConfig(input.messageId);
        const permissions = yield* policy.forUser(input.userId);
        const selectedFeatureUnavailable =
          (config.agentId && !permissions.agentsUse) ||
          (config.collectionIds.length && !permissions.knowledgeUse) ||
          ((config.skills?.length ?? 0) > 0 && !permissions.skillsUse) ||
          (config.searchEnabled && !permissions.webSearch) ||
          (config.researchEnabled && (!permissions.deepResearch || !permissions.webSearch)) ||
          (config.desktopFolders && !permissions.work);
        // Modules are read here rather than stored with the config: a plain
        // chat offers every module the sender may use, an agent narrows that
        // to what it attached, and a disabled, deleted or no-longer-shared
        // module drops out rather than failing the attempt. The list is held
        // for this generation only.
        const customToolManifests = yield* customToolRepo.resolveForAttempt(
          input.userId,
          config.resolvedAgent?.customToolIds ?? "all",
        );
        // Like custom tools, read as the generation starts and held for it: the
        // chat's own choices (or a schedule fire's grants) and the sender's
        // connections as they are now. A lost connection drops out quietly.
        const integrationOffer = yield* integrations.resolveOffer({
          userId: input.userId,
          conversationId: input.conversationId,
          grants: config.integrationGrants ?? null,
        });
        const runtimeContext = runtimeContextMessage(new Date(), input.timeZone);
        // Snapshot the model row up front: the ledger wants its display name
        // and pricing even if the admin deletes or reprices it mid-generation.
        const model = yield* providers.getModel(input.modelId);
        const history = yield* repo.listMessages(input.conversationId);
        // A resumed answer starts from what it already produced: its rows are
        // the rounds this attempt continues, read once here.
        const resuming = input.resume === true && currentMessage !== null;
        const ownCalls = resuming ? yield* repo.listToolCalls([input.messageId]) : [];
        const ownCompactions = resuming ? yield* repo.listCompactionEvents([input.messageId]) : [];
        const ownSteers = resuming
          ? history.filter(
              (m) => m.steeredIntoMessageId === input.messageId && m.status === "complete",
            )
          : [];
        const ownFiles = resuming ? (currentMessage.assistantOutput?.files ?? []) : [];
        // Past every position the answer has used, so unique row positions and
        // turn order stay one space. The service refused a resume with none left.
        const firstTurn = resuming
          ? resumeFirstTurn({
              calls: ownCalls,
              compactions: ownCompactions,
              steerTurns: ownSteers.map((m) => m.steerTurnIndex ?? -1),
              files: ownFiles,
              replay: currentMessage.providerReplay,
            })
          : 0;
        // Each attempt gets the full budget, bounded only by research's space.
        const roundLimit = Math.max(
          0,
          Math.min(MAX_TOOL_ROUNDS, RESEARCH_TURN_BASE - 1 - firstTurn),
        );
        const settled = history.filter(
          (m) =>
            m.id !== input.messageId &&
            (m.status === "complete" ||
              (m.status !== "streaming" && !!m.assistantOutput?.files.length)),
        );
        // A steer is part of the answer it was delivered into, so it leaves
        // the history list and is rendered inside that answer. One whose
        // answer is not in history went with that attempt.
        const answers = new Set(settled.filter((m) => m.role === "assistant").map((m) => m.id));
        const steersByAnswer = new Map<string, HistorySteer[]>();
        for (const m of settled) {
          if (!m.steeredIntoMessageId || !answers.has(m.steeredIntoMessageId)) continue;
          const list = steersByAnswer.get(m.steeredIntoMessageId) ?? [];
          // Rows from before positions were recorded read as arriving first.
          list.push({
            ...m,
            textOffset: m.steerTextOffset ?? 0,
            turnIndex: m.steerTurnIndex ?? -1,
          });
          steersByAnswer.set(m.steeredIntoMessageId, list);
        }
        const rawCompleted = settled.filter((m) => !m.steeredIntoMessageId);
        // Desktop sends carry their drops on the assistant attempt's config,
        // not the user message text. Key each prior attempt's names back to its
        // preceding user message, then add this attempt's own names to the last
        // user message. Without this annotation the model never learns what its
        // workspace gained.
        const workspaceFilesByAttempt = yield* repo.listWorkspaceFilesByMessage(
          rawCompleted
            .filter((message) => message.role === "assistant")
            .map((message) => message.id),
        );
        const workspaceFilesBySend = new Map<string, ReadonlyArray<string>>();
        for (let index = 0; index < rawCompleted.length; index++) {
          const files = workspaceFilesByAttempt.get(rawCompleted[index]!.id);
          if (!files) continue;
          for (let previous = index - 1; previous >= 0; previous--) {
            const candidate = rawCompleted[previous]!;
            if (candidate.role !== "user") continue;
            workspaceFilesBySend.set(candidate.id, files);
            break;
          }
        }
        const currentSend = rawCompleted.at(-1);
        if (
          currentSend?.role === "user" &&
          config.workspaceFiles &&
          config.workspaceFiles.length > 0
        )
          workspaceFilesBySend.set(currentSend.id, config.workspaceFiles);
        const completed = rawCompleted.map((message) => {
          const files = workspaceFilesBySend.get(message.id);
          return files ? Object.assign({}, message, { workspaceFiles: files }) : message;
        });
        // Steers are the person's own words, so their links grant the reader
        // authority exactly as any other user message's do.
        const readerUrls = extractUserMessageUrls([
          ...completed,
          ...[...steersByAnswer.values()].flat(),
          ...ownSteers,
        ]);

        // Seed conversation citation numbers and the recap from persisted sources.
        // A resumed answer's own sources count: its text already cites them,
        // and links it found must remain readable.
        const priorToolCalls = [
          ...(yield* repo.listToolCalls(
            history
              .filter((m) => m.id !== input.messageId && m.role === "assistant")
              .map((m) => m.id),
          )),
          ...ownCalls,
        ];
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

        const earlierUsage = resuming ? currentMessage.usage : null;
        // The resume claim set the row's text to what its chunks spell.
        let seq = resuming ? yield* repo.lastChunkSeq(input.messageId) : 0;
        let assembled = resuming ? currentMessage.content : "";
        let assembledReasoning = resuming ? (currentMessage.reasoning ?? "") : "";
        let acceptedImages = 0;
        // A resumed image answer keeps the signed turns its model wrote; the
        // resume transaction already cleared them for a different model.
        const storedReplay = resuming ? currentMessage.providerReplay : null;
        let replay: ProviderReplay | null =
          storedReplay &&
          storedReplay.providerId === model?.providerId &&
          storedReplay.modelKey === model.modelKey
            ? storedReplay
            : null;
        const imageOutput = model?.capabilities.imageOutput === true;
        let imageCostIncomplete = false;
        let modelCallOpen = false;
        let buffer: Array<{ seq: number; kind: ChunkKind; delta: string }> = [];

        // Persist first, then publish: a subscriber's one-shot DB replay must
        // never miss a chunk already announced live. Uninterruptible from the
        // buffer swap on: the flusher races the generation finishing, and an
        // interrupt between clearing the buffer and inserting would lose that
        // seq range, breaking the contiguity resume relies on.
        const writer = yield* Semaphore.make(1);
        const flush = writer.withPermits(1)(
          Effect.uninterruptible(
            Effect.suspend(() => {
              const batch = buffer;
              buffer = [];
              // Nothing to write still renews the lease for ordinary chat, so a
              // slow first token or a long tool round cannot get the row reaped
              // mid-answer. Research keeps its own lease on the run.
              if (batch.length === 0)
                return fence
                  ? repo.renewGenerationLease(input.messageId, fence.generationId)
                  : Effect.void;
              return repo.appendChunks(input.messageId, batch).pipe(
                Effect.flatMap(() =>
                  Effect.forEach(
                    batch,
                    (chunk) =>
                      PubSub.publish(pubsub, {
                        kind: "chunk",
                        ...(fence ? { runId: fence.generationId } : {}),
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
                      // The row's text spans every attempt of a resumed answer,
                      // so its usage does too; the ledger keeps one row per attempt.
                      inputTokens: (earlierUsage?.inputTokens ?? 0) + totals.inputTokens,
                      outputTokens: (earlierUsage?.outputTokens ?? 0) + totals.outputTokens,
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
              ledger: {
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
              },
            });
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
            yield* (yield* GenerationSettled)({
              userId: input.userId,
              conversationId: input.conversationId,
              messageId: input.messageId,
              status,
            });
          });

        // Outside `generate`: a stopped generation is interrupted mid-effect,
        // and the tokens it already burned still have to be recorded. A turn
        // interrupted before its finish part contributes nothing, since the
        // provider never sent the numbers.
        const totals = emptyUsageTotals();
        // The estimator's calibration pair, persisted at finalize: what the
        // provider counted for the first model call, and what we predicted for
        // that same prompt. Only the first call maps onto one prompt;
        // `totals.inputTokens` sums every tool round.
        let sawFirstFinish = false;
        let firstInputTokens: number | undefined;
        let estimatedFirstInputTokens: number | undefined;

        const generate = Effect.gen(function* () {
          if (selectedFeatureUnavailable)
            return yield* Effect.fail(new Error("A selected feature is no longer available"));
          const writeGuard = (tx: DbTx) => (fence ? lockGeneration(tx, fence) : Effect.interrupt);
          const authoring = yield* prepareAgentDraftTools({
            services: authoringServices,
            userId: input.userId,
            conversationId: input.conversationId,
            messageId: input.messageId,
            currentModelId: input.modelId,
            writeGuard,
          });
          const scheduleAuthoring = yield* prepareScheduleDraftTools({
            services: scheduleAuthoringServices,
            userId: input.userId,
            conversationId: input.conversationId,
            messageId: input.messageId,
            currentModelId: input.modelId,
            writeGuard,
          });
          const documents = yield* prepareDocumentTools({
            service: documentService,
            userId: input.userId,
            conversationId: input.conversationId,
            messageId: input.messageId,
            openDocumentId: input.openDocumentId,
            writeGuard,
            liveGuard: (tx: DbTx) => (fence ? ensureGenerationLive(tx, fence) : Effect.interrupt),
            project: config.resolvedProject
              ? {
                  id: config.resolvedProject.id,
                  name: config.resolvedProject.name,
                  canEdit: projectCan.edit(config.resolvedProject.role),
                }
              : null,
          });
          // Only in a project chat, and only for an answer that can be fenced.
          const projectFileTools =
            config.resolvedProject && fence && Option.isSome(projectFiles)
              ? prepareProjectFileTools({
                  service: projectFiles.value,
                  userId: input.userId,
                  conversationId: input.conversationId,
                  generationId: fence.generationId,
                  project: {
                    id: config.resolvedProject.id,
                    canEdit: projectCan.edit(config.resolvedProject.role),
                  },
                  writeGuard,
                })
              : null;
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
          const webTools = permissions.webSearch
            ? yield* prepareWebTools({
                webSearch,
                urlReader,
                indexer,
                authority,
                requestSearch: input.searchEnabled,
              })
            : null;

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
          const skillManifest = permissions.skillsUse
            ? [
                ...(config.skills ?? []),
                ...(yield* skillReader.catalogue(
                  input.userId,
                  (config.skills ?? []).map((entry) => entry.skillId),
                )),
              ]
            : [];
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
          // Replaced each turn, because a provider call id is unique only
          // within one and a handler only ever runs inside one.
          const turnCallRows = new Map<string, Deferred.Deferred<ToolCallRowRef | undefined>>();
          const callRowReady = (providerCallId: string) => {
            let ready = turnCallRows.get(providerCallId);
            if (!ready) {
              ready = Deferred.makeUnsafe<ToolCallRowRef | undefined>();
              turnCallRows.set(providerCallId, ready);
            }
            return ready;
          };
          // Machine tools wait for the page that sent the attempt to run them.
          const rowIdFor = (providerCallId: string) =>
            Effect.suspend(() => Deferred.await(callRowReady(providerCallId))).pipe(
              Effect.map((row) => row?.rowId),
            );
          // Offered only when the machine that sent this message reported its
          // folders (a Work attempt always has the app's workspace), so a
          // browser tab never sees these names.
          const desktopTools =
            config.desktopFolders && permissions.work
              ? prepareDesktopTools({ rowIdFor, commands: config.desktopCommands ?? false })
              : null;
          // Work attempts from an app that can embed pages, attached folder or
          // not; they run in the sending app's own tabs.
          const browserTools =
            permissions.work && config.desktopBrowser ? prepareBrowserTools({ rowIdFor }) : null;
          // The checklist is an agent preference. Retry and edit start from a
          // clean list: a completed step is a claim about work this attempt did.
          // Resume continues that same work, so it keeps the last accepted list.
          const resumedPlan = ownCalls
            .filter((call) => call.toolName === "update_plan" && call.status === "complete")
            .map((call) => Schema.decodeUnknownOption(PlanSnapshot)(call.result))
            .findLast(Option.isSome);
          const planTools = config.planEnabled
            ? preparePlanTool(resumedPlan?.value ?? null)
            : undefined;
          // Admins switch Office file editing off in Tools; read per attempt so
          // it applies to the next answer. A missing row keeps the default, on.
          const officeFiles = Option.isSome(toolRegistry)
            ? yield* toolRegistry.value.getTool("office_files")
            : null;
          const officeOffered = (officeFiles?.enabled ?? true) && Option.isSome(database);
          const officeEditors = officeOffered ? runnableOfficeFamilies(processors) : [];
          // Admin-authored tools are resolved once as this generation starts,
          // then held stable for its remaining tool rounds. An edit or deletion
          // mid-flight changes nothing here. A module revises only its own drafts.
          const customToolOwners = new Map(
            customToolManifests.flatMap((tool) =>
              tool.functions.map(
                (fn) =>
                  [customToolName(tool.slug, fn.key), `custom:${tool.toolId}` as const] as const,
              ),
            ),
          );
          const offeredOwners = new Set<string>([...officeEditors, ...customToolOwners.values()]);
          // Drafts earlier answers left, for the editors this answer is offered.
          const kept = keptFiles
            ? (yield* keptFiles.list(input.conversationId)).filter((file) =>
                offeredOwners.has(file.owner),
              )
            : [];
          // After each round and when the answer ends however it ends: changed
          // drafts under the fence, so a crash loses at most one round and a
          // stopped, failed or questioning answer leaves them for the next one.
          // A superseded attempt is fenced out and saves nothing.
          const keepChanges = (workspace: WorkingFiles) =>
            fence && keptFiles
              ? Effect.forEach(
                  workspace.changes(),
                  (file) =>
                    keptFiles.keep(fence, file).pipe(
                      Effect.andThen(Effect.sync(() => workspace.markKept(file.ref))),
                      Effect.catchTag("AttachmentRejected", (error) =>
                        Effect.logWarning(`working file ${file.name} not kept: ${error.reason}`),
                      ),
                    ),
                  { discard: true },
                ).pipe(Effect.exit, Effect.asVoid)
              : Effect.void;
          const workingFiles = yield* Effect.acquireRelease(
            Effect.sync(() =>
              createWorkingFiles({
                kept,
                // A draft opened from a chat or project file is only as readable
                // as that file still is for the sender.
                load: async (file) => {
                  if (
                    file.source !== undefined &&
                    !(await Effect.runPromise(
                      toolFiles?.authorize(file.source) ?? Effect.succeed(false),
                    ))
                  )
                    throw new Error("The file this draft was opened from is no longer available.");
                  if (!keptFiles) throw new Error("This working file is no longer available.");
                  return Effect.runPromise(keptFiles.load(file));
                },
              }),
            ),
            (workspace) =>
              keepChanges(workspace).pipe(Effect.ensuring(Effect.sync(() => workspace.dispose()))),
          );
          const toolFiles = Option.isSome(database)
            ? makeToolFileResolver({
                db: database.value,
                store: promptDeps.store,
                projectFiles,
                userId: input.userId,
                conversationId: input.conversationId,
                projectId: config.resolvedProject?.id ?? null,
                workspace: workingFiles,
                ...(skillManifest.length
                  ? { skills: { entries: skillManifest, reader: skillReader } }
                  : {}),
              })
            : undefined;
          let previewTurnFiles: Array<Prompt.UserMessagePartEncoded> = [];
          let previewCount = 0;
          let previewBytes = 0;
          // Fonts a loaded skill carries render in this answer's previews. Read
          // again only when the loaded set changes; a face that fails is skipped.
          let skillFaceSet: { key: string; faces: Promise<readonly FontFace[]> } | null = null;
          const skillFaces = (): Promise<readonly FontFace[]> => {
            if (!skillTools || Option.isNone(presentationFonts)) return Promise.resolve([]);
            const entries = skillTools.loadedSkills();
            const key = entries.map((entry) => entry.revisionId).join(",");
            if (skillFaceSet?.key !== key)
              skillFaceSet = {
                key,
                faces: Effect.runPromise(
                  Effect.gen(function* () {
                    const fonts: Array<{ sha256: string; bytes: Uint8Array }> = [];
                    for (const entry of entries)
                      for (const file of yield* skillReader.listFiles(input.userId, entry)) {
                        if (file.mediaType !== "font/ttf" && file.mediaType !== "font/otf")
                          continue;
                        if (fonts.length >= SKILL_FONT_FACES) break;
                        const read = yield* skillReader.readPinnedBytes(
                          input.userId,
                          entry,
                          file.path,
                        );
                        if (read) fonts.push({ sha256: sha256Hex(read.bytes), bytes: read.bytes });
                      }
                    return yield* presentationFonts.value.skillFaces(fonts);
                  }).pipe(Effect.orElseSucceed(() => [])),
                ),
              };
            return skillFaceSet.faces;
          };
          const officeTools =
            officeEditors.length && toolFiles
              ? prepareOfficeTools(processors, {
                  owner: input.userId,
                  workingFiles,
                  resolveFile: toolFiles.resolve,
                  presentation: {
                    // Loaded skills' fonts ride along with every job.
                    faces: skillFaces,
                    ...(Option.isSome(presentationFonts)
                      ? {
                          fonts: async () => [
                            ...new Set([
                              ...(await Effect.runPromise(presentationFonts.value.families())),
                              ...(await skillFaces()).map((face) => face.family),
                            ]),
                          ],
                        }
                      : {}),
                    ...(model?.capabilities.vision
                      ? {
                          onPreview: async (
                            slides: readonly { slideId: number; png: Uint8Array; label: string }[],
                          ) => {
                            const bytes = slides.reduce(
                              (total, slide) => total + slide.png.length,
                              0,
                            );
                            if (
                              previewCount + slides.length > PREVIEW_FEEDBACK_LIMITS.slides ||
                              previewBytes + bytes > PREVIEW_FEEDBACK_LIMITS.bytes
                            )
                              throw new Error(
                                "This attempt has exhausted its visual preview budget.",
                              );
                            const feedback = await Promise.all(
                              slides.map((slide) =>
                                Effect.runPromise(
                                  fileForModel(promptDeps.parser, {
                                    fileName: `${slide.label}.png`,
                                    mediaType: "image/png",
                                    bytes: slide.png,
                                    vision: true,
                                    files: model.capabilities.files ?? false,
                                  }),
                                ),
                              ),
                            );
                            previewCount += slides.length;
                            previewBytes += bytes;
                            previewTurnFiles.push(...feedback);
                          },
                        }
                      : {}),
                  },
                })
              : [];
          // The Office family whose tools this answer offers under `name`.
          const offeredOffice = new Set(officeTools.map((tool) => tool.family));
          const officeFamilyOf = (name: string) => {
            const family = officeFamilyOfTool(name);
            return family && offeredOffice.has(family)
              ? { family, ...OFFICE_FAMILIES[family] }
              : null;
          };
          const customTools = customToolManifests.length
            ? prepareCustomTools(customToolManifests, customToolRuntime, toolFiles?.resolve)
            : undefined;
          // Drafts exist only where an editor is offered, and so does delivery.
          // Machine tools return files too (screenshots, reads, imports), which
          // only publishing delivers.
          const publishFileTool =
            officeTools.length || customTools || desktopTools || browserTools
              ? preparePublishFileTool(workingFiles)
              : undefined;
          // Fixed for the whole answer: it sits ahead of this answer's rounds,
          // so changing it between rounds would uncache every round after it.
          // Names are file data, so they are quoted rather than trusted as policy.
          const keptNotice: ReadonlyArray<Prompt.MessageEncoded> =
            kept.length && publishFileTool
              ? [
                  {
                    role: "user",
                    content: `<application-policy>\nUnpublished working files kept from ${resuming ? "this answer before it was interrupted, or from earlier answers," : "earlier answers"} in this chat. Continue one by passing its reference to the tool that made it (a presentation, spreadsheet or Word tool takes it as workingRef, alone, never with sourceRef); publish_file delivers it. Each reference names the draft's latest saved revision.\n${kept
                      .map((file) => `- ${formatFileRef(file.ref)} ${quotedName(file.name)}`)
                      .join("\n")}\n</application-policy>`,
                  },
                ]
              : [];
          // Display names by model-facing tool name. This map, not the
          // `custom_` prefix, decides what is a custom tool call: a model can
          // invent a `custom_…` name, and the SDK still forwards that part.
          const customToolNames = new Map(
            customToolManifests.flatMap((tool) =>
              tool.functions.map((fn) => [customToolName(tool.slug, fn.key), fn.name] as const),
            ),
          );
          const customToolDisplayName = (name: string) => {
            const displayName = customToolNames.get(name);
            if (!displayName) throw new Error(`Missing pinned custom tool manifest for ${name}`);
            return displayName;
          };
          const integrationTools = integrationOffer.length
            ? prepareIntegrationTools({
                offered: integrationOffer,
                indexer,
                approvals: integrationApprovals,
                owner: {
                  userId: input.userId,
                  conversationId: input.conversationId,
                  messageId: input.messageId,
                },
                permissionsFor: (integrationId) =>
                  integrations.permissionsFor(input.userId, input.conversationId, integrationId),
                sessionFor: (integrationId) =>
                  integrations
                    .session(input.userId, integrationId)
                    .pipe(Effect.orElseSucceed(() => null)),
                rowIdFor: (providerCallId) =>
                  Effect.suspend(() => Deferred.await(callRowReady(providerCallId))).pipe(
                    Effect.map((row) => row?.rowId),
                  ),
                reportAuthFailure: (session) =>
                  integrations.reportAuthFailure({
                    userId: input.userId,
                    connectionId: session.connectionId,
                  }),
              })
            : undefined;
          let knowledgeContext: PreparedKnowledgeContext | null = null;
          let contextRowWritten = false;
          const knowledgeTools = knowledgeSession
            ? yield* prepareKnowledgeTools({
                userId: input.userId,
                session: knowledgeSession,
                indexer,
              }).pipe(Effect.provideService(KnowledgeService, knowledgeService))
            : null;

          // Read per attempt, so Keep takes effect on the next one. A chat
          // deleted underneath this attempt counts as temporary: fail closed.
          const temporary = yield* repo.getConversation(input.userId, input.conversationId).pipe(
            Effect.map((row) => row.temporary),
            Effect.catchTag("ConversationNotFound", () => Effect.succeed(true)),
          );
          const conversationContext = yield* prepareConversationContext({
            memory,
            projectMemory,
            project: config.resolvedProject ?? null,
            userId: input.userId,
            conversationId: input.conversationId,
            history: completed,
            memoryDisabled: temporary,
          });
          const { memoryTools } = conversationContext;
          const memorySpent = ownCalls.some((call) => call.toolName === "save_memory");
          // Research is a tool on an ordinary turn: the model writes the brief
          // and answers from the evidence. The run it starts is owned by its
          // tool call and fenced by this generation.
          const researchTool =
            permissions.deepResearch &&
            permissions.webSearch &&
            config.researchEnabled &&
            repo.research &&
            fence
              ? prepareResearchTool({
                  store: repo.research,
                  gateway,
                  providers,
                  webSearch,
                  urlReader,
                  userUrls: readerUrls,
                  priorSources,
                  config,
                  knowledge: knowledgeSession
                    ? { session: knowledgeSession, service: knowledgeService }
                    : null,
                  ...(skillReader ? { skillReader } : {}),
                  userId: input.userId,
                  conversationId: input.conversationId,
                  messageId: input.messageId,
                  generationId: fence.generationId,
                  modelId: input.modelId,
                  rowFor: (providerCallId) =>
                    Effect.suspend(() => Deferred.await(callRowReady(providerCallId))),
                  emit: pushToolChunk,
                  emitCompaction: pushCompactionChunk,
                })
              : null;
          // Offered by name only until loaded; see `tool-load.ts`. The set grows
          // through the answer and never shrinks within it.
          // A file too long to inline, or one summarized away, stays readable
          // by id; only files linked to this conversation's messages are.
          const conversationFiles = yield* promptDeps.attachments.listWithBlobsForMessages([
            ...completed.map((message) => message.id),
            ...ownSteers.map((steer) => steer.id),
          ]);
          const attachmentReader = conversationFiles.some(
            (file) =>
              ["text", "pdf"].includes(attachmentKind(file.mediaType)) ||
              hasFileText(file.fileName),
          )
            ? prepareAttachmentReader({
                deps: promptDeps,
                find: (attachmentId) =>
                  Effect.succeed(
                    conversationFiles.find((file) => file.id === attachmentId) ?? null,
                  ),
              })
            : undefined;
          const offeredLazy = LazyToolFamily.literals.filter((family) =>
            family === "agent-draft"
              ? permissions.agentsCreate
              : family === "schedule-draft"
                ? permissions.schedules
                : offeredOffice.has(family),
          );
          const unlockedFamilies = new Set<LazyToolFamily>();
          const unlockTool = (name: string) => {
            const family = lazyFamilyOfTool(name);
            if (family && offeredLazy.includes(family)) unlockedFamilies.add(family);
          };
          const toolLoad = offeredLazy.length
            ? prepareToolLoad({ offered: offeredLazy, unlocked: unlockedFamilies })
            : undefined;
          // A stored call that shows a family was in use: an explicit load, a
          // call to one of its tools, or the authoring skill that drives it.
          const unlockByCall = (
            into: Set<LazyToolFamily>,
            call: { toolName: string; result: unknown },
          ) => {
            const add = (name: string) => {
              const family = lazyFamilyOfTool(name);
              if (family && offeredLazy.includes(family)) into.add(family);
            };
            if (call.toolName === "load_tools") {
              const loaded = Schema.decodeUnknownOption(LoadToolsResult)(call.result);
              if (Option.isSome(loaded))
                for (const family of loaded.value.loaded)
                  if (offeredLazy.includes(family)) into.add(family);
            } else if (call.toolName === "load_skill") {
              const skillId = (call.result as { skillId?: unknown } | null)?.skillId;
              if (skillId === "builtin:agent-authoring") add("draft_agent");
              if (skillId === "builtin:schedule-authoring") add("draft_schedule");
            } else add(call.toolName);
          };
          const commonGroups = [
            ...(toolLoad ? [toolLoad] : []),
            ...(attachmentReader ? [attachmentReader] : []),
            ...(permissions.agentsCreate ? [authoring.group] : []),
            ...(permissions.schedules ? [scheduleAuthoring.group] : []),
            ...(permissions.documents ? [documents.group] : []),
            ...(projectFileTools ? [projectFileTools.group] : []),
            ...(researchTool ? [researchTool.group] : []),
            ...(desktopTools ? [desktopTools] : []),
            ...(browserTools ? [browserTools] : []),
            ...(skillTools ? [skillTools.group] : []),
            ...(webTools ? [webTools.group] : []),
            ...(planTools ? [planTools.group] : []),
            ...officeTools.map((tool) => tool.group),
            ...(customTools ? [customTools.group] : []),
            ...(publishFileTool ? [publishFileTool.group] : []),
            ...(integrationTools ? [integrationTools.group] : []),
            ...(askTools ? [askTools] : []),
          ];
          // Reserve retrieval schemas before preparation: a context selection
          // may downgrade once rendered. Execution tools are built afterwards.
          const budgetToolkit = yield* mergeToolGroups([
            ...commonGroups,
            ...(knowledgeTools ? [knowledgeTools.group] : []),
            ...(memoryTools ? [memoryTools.group] : []),
          ]);
          // Only advertised schemas cost input. Before the retained history is
          // known, reserve for every family anything in this chat has used.
          const schemaTokensWith = (unlocked: ReadonlySet<LazyToolFamily>) =>
            budgetToolkit &&
            estimateToolSchemaTokens({
              tools: Object.fromEntries(
                Object.entries(budgetToolkit.tools).filter(([name]) =>
                  isAdvertised(name, offeredLazy, unlocked),
                ),
              ),
            });
          const everUnlocked = new Set<LazyToolFamily>();
          for (const call of priorToolCalls)
            if (call.researchRunId === null) unlockByCall(everUnlocked, call);
          for (const file of kept) if (isOfficeFamily(file.owner)) everUnlocked.add(file.owner);
          const toolSchemaTokens = schemaTokensWith(everUnlocked) ?? 0;
          const summaryToolChoice = (toolkit: { tools: Record<string, unknown> }) => {
            const names = Object.keys(toolkit.tools).filter(
              (name) =>
                isAdvertised(name, offeredLazy, everUnlocked) &&
                (retrievalEnabled || !Schema.is(KnowledgeToolName)(name)) &&
                !(memorySpent && name === "save_memory"),
            );
            return names.length < Object.keys(toolkit.tools).length
              ? { oneOf: names }
              : ("auto" as const);
          };
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
          // A skill an earlier answer loaded replays just before that answer
          // (first retained load only), so its text caches with the history
          // instead of reloading into trailing context every turn. A pinned
          // skill's synthetic row is no load: it is re-pinned each attempt.
          const skillLoads = new Map<string, string[]>();
          const seenSkills = new Set<string>();
          for (const message of skillTools ? historySuffix : []) {
            for (const call of priorToolCalls) {
              if (
                call.messageId !== message.id ||
                call.toolName !== "load_skill" ||
                call.status !== "complete" ||
                call.providerCallId.startsWith("skill-context:")
              )
                continue;
              const skillId = (call.result as { skillId?: unknown } | null)?.skillId;
              if (typeof skillId !== "string" || seenSkills.has(skillId)) continue;
              seenSkills.add(skillId);
              skillLoads.set(message.id, [...(skillLoads.get(message.id) ?? []), skillId]);
            }
          }
          const skillRoots = skillTools
            ? yield* skillTools.readEarlier([...seenSkills])
            : new Map<string, string>();
          const skillReplay = (message: { id: string }) =>
            (skillLoads.get(message.id) ?? []).flatMap((skillId) => {
              const root = skillRoots.get(skillId);
              return root === undefined ? [] : [earlierSkillMessage(skillId, root)];
            });
          // Compaction drops whole history groups, replays included, so the
          // session is told which replayed skills the retained history holds.
          const syncEarlierSkills = (startIndex: number) =>
            skillTools?.setEarlier(
              new Set(
                historySuffix
                  .slice(startIndex)
                  .flatMap((message) =>
                    (skillLoads.get(message.id) ?? []).filter((skillId) => skillRoots.has(skillId)),
                  ),
              ),
            );
          // Only one-to-one rows can be indexed by position. File metadata and
          // replay turns expand one stored answer into several prompt messages.
          const plainHistory = historySuffix.filter(
            (message) =>
              !message.assistantOutput?.files.length &&
              !message.providerReplay?.turns.length &&
              !steersByAnswer.has(message.id),
          );
          const plainMessages = yield* buildHistoryMessages(promptDeps, {
            deferAssistantBytes: true,
            messages: plainHistory,
            modelSupportsFiles: model?.capabilities.files ?? false,
            inlineTextChars: inlineTextCharsFor(model?.contextLength),
          });
          const plainById = new Map(
            plainHistory.map((message, index) => [message.id, plainMessages[index]!]),
          );
          const historyGroups: Array<ReadonlyArray<Prompt.MessageEncoded>> = [];
          for (const message of historySuffix) {
            historyGroups.push([
              ...skillReplay(message),
              ...(message.assistantOutput?.files.length ||
              message.providerReplay?.turns.length ||
              steersByAnswer.has(message.id)
                ? yield* buildHistoryMessages(
                    { ...promptDeps, chat: repo },
                    {
                      messages: [message],
                      steers: steersByAnswer,
                      deferAssistantBytes: true,
                      expandAssistantTurns: true,
                      modelSupportsFiles: model?.capabilities.files ?? false,
                      inlineTextChars: inlineTextCharsFor(model?.contextLength),
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
                : [plainById.get(message.id)!]),
            ]);
          }
          // Compaction indexes stored rows; each representative's full group is
          // supplied alongside it for token estimates and summary input.
          const historyMessages = historyGroups.map((group) => group[0]!);
          const sourcesByIndex = new Map(priorSources.map((source) => [source.index, source]));
          const recapSources = () => {
            const sources = [...sourcesByIndex.values()];
            // oxlint-disable-next-line no-array-sort -- fresh array from Map values
            sources.sort((a, b) => a.index - b.index);
            return sources.slice(-MAX_PRIOR_SOURCES);
          };
          const sourceManifest = () =>
            recapSources()
              .map((source) => `[${source.index}] ${source.title}: ${sourceTarget(source)}`)
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
          // History keeps its citation markers for a stable cached prefix, so an
          // attempt with nothing to cite says so here instead of stripping them.
          const citesNothing =
            webTools === undefined &&
            integrationTools === undefined &&
            knowledgeSession === null &&
            historySuffix.some(
              (message) => message.role === "assistant" && /\[\^\d+\]/.test(message.content),
            );
          let currentRound = 0;
          // The round whose results a steer followed; its next call alone is told how to read it.
          let steeredAfter: number | null = null;
          // Unfinished drafts by reference; a name is file data, so it is quoted.
          const draftList = () =>
            workingFiles
              .unfinished()
              .map((file) => `${formatFileRef(file.ref)} ${quotedName(file.name)}`)
              .join(", ");
          // Only where drafts can exist, and only near the end.
          const draftReminder = (lastCycle: boolean) => {
            const roundsRemaining = Math.max(0, roundLimit - currentRound);
            if (!publishFileTool || roundsRemaining > 8) return null;
            const drafts = draftList();
            return lastCycle
              ? `No tool rounds remain. Unpublished working files (${drafts || "none"}) cannot be delivered in this response; edited drafts stay in this chat for a later answer. Do not claim they are attached.`
              : `Tool rounds remaining: ${roundsRemaining}. ${drafts ? `Publish unfinished working files before tools become unavailable: ${drafts}.` : "Finish the response when ready."}`;
          };
          const reminderPrompt = (lastCycle: boolean) => {
            const sections = [
              resuming && currentRound === 0 ? RESUME_REMINDER : null,
              draftReminder(lastCycle),
              webTools ? buildSearchReminder({ sources: recapSources(), lastCycle }) : null,
              citesNothing
                ? "Citation markers like [^1] in earlier answers point at sources from earlier turns. This answer has no sources to cite, so write no citation markers."
                : null,
              // Arriving after tool results, a bare user message reads like a new
              // turn, and models answered a progress question then stopped.
              steeredAfter === currentRound - 1
                ? "The user sent the message above while you were working. Address it briefly, then continue the task unless it asks you to stop or change course."
                : null,
              knowledgeReminder(),
              skillTools && skillTools.remaining() < SKILL_LIMITS.operations
                ? `Skill operations remaining: ${skillTools.remaining()} of ${SKILL_LIMITS.operations}.`
                : null,
              planReminder(),
            ].filter(Boolean);
            const messages = [
              ...contextUpdates(),
              ...(sections.length > 0 ? [systemReminderMessage(sections.join("\n\n"))] : []),
            ];
            return messages.length > 0 ? Prompt.make(messages) : null;
          };
          // Everything after retained history, in order. It is the one list both
          // the transcript and the compaction budget read, so anything added
          // here is automatically budgeted. Rebuilt per call since loaded skills
          // and the clock change; being after history keeps the cacheable prefix
          // intact when they do.
          const trailingContext = (): ReadonlyArray<Prompt.MessageEncoded> => [
            ...(permissions.agentsCreate ? authoring.messages() : []),
            ...(permissions.schedules ? scheduleAuthoring.messages() : []),
            ...(permissions.documents ? documents.messages() : []),
            ...(knowledgeContext?.messages ?? []),
            ...(skillTools?.messages() ?? []),
            ...keptNotice,
            runtimeContext,
          ];
          // Fixed as the answer's first request saw it: it sits ahead of every
          // round, so a change there would uncache them all. Later changes (an
          // edited draft, a skill loaded mid-answer) go after the rounds, and
          // their policies say a later copy replaces an earlier one.
          let answerContext: ReadonlyArray<Prompt.MessageEncoded> | null = null;
          const startContext = () => (answerContext ??= trailingContext());
          const contextUpdates = (): Prompt.MessageEncoded[] => {
            if (!answerContext) return [];
            const before = new Set(answerContext.map((message) => JSON.stringify(message.content)));
            return trailingContext().filter(
              (message) => !before.has(JSON.stringify(message.content)),
            );
          };
          // Reminders are appended per request rather than stored in the
          // transcript, so only the budget adds them to the tail.
          const historyBudgetTail = (lastCycle: boolean): ReadonlyArray<Prompt.MessageEncoded> => [
            ...(answerContext ?? trailingContext()),
            ...((reminderPrompt(lastCycle)?.content ?? []) as ReadonlyArray<Prompt.MessageEncoded>),
          ];

          // Tool policies + memory data + history are the stable prefix.
          // Actual memory records sit in a lower-authority assistant/data message;
          // only the application-authored handling policy is a system message.
          const fixedPrefix = buildFixedPrefix({
            lazyFamilies: offeredLazy,
            agentAuthoring: permissions.agentsCreate,
            documents: permissions.documents,
            knowledge: !!knowledgeSession,
            web: webTools ? webTools.tools : null,
            integrations: integrationTools
              ? [
                  ...new Set(
                    [...integrationTools.names.values()].map(
                      (entry) => findIntegration(entry.integrationId)?.name ?? entry.integrationId,
                    ),
                  ),
                ]
              : null,
            research: !!researchTool,
            desktop: desktopTools
              ? { folders: input.desktopFolders ?? [], commands: config.desktopCommands ?? false }
              : null,
            browser: !!browserTools,
            memory: conversationContext.messages(),
            project: config.resolvedProject ?? null,
            agent: config.resolvedAgent ?? null,
          });

          // Synchronously, before a single token streams: a summary written
          // after the answer would be a summary of the wrong prompt. Failure
          // here (nothing left to drop) finalizes the message as an error.
          // Budgeted as if all history were kept, then narrowed to what was.
          syncEarlierSkills(0);
          let compaction: CompactionDecision = yield* prepareCompactedHistory(
            { gateway, repo, providers, analytics },
            {
              userId: input.userId,
              conversationId: input.conversationId,
              messageId: input.messageId,
              modelId: input.modelId,
              contextLength: model?.contextLength,
              toolSchemaTokens,
              existingCheckpoint: selected?.checkpoint ?? null,
              textOffset: assembled.length,
              beforeTurnIndex: firstTurn,
              maxStartIndex,
              messages: historySuffix,
              renderedMessages: historyMessages,
              renderedMessageGroups: historyGroups,
              fixedPrefix,
              trailingMessages: historyBudgetTail(false),
              webToolsEnabled: webTools !== undefined,
              priorUsage,
              onCompaction: (event) => pushCompactionChunk({ v: 1, ...event }),
              // The tools and settings the first request will most likely send,
              // so a summary over this prompt reads it from the provider cache.
              ...(budgetToolkit
                ? {
                    summaryRequest: {
                      toolkit: budgetToolkit,
                      toolChoice: summaryToolChoice(budgetToolkit),
                      reasoningEffort: config.reasoningEffort,
                      cacheKey: input.conversationId,
                    },
                  }
                : {}),
            },
          );
          syncEarlierSkills(compaction.startIndex);

          // What retained history already worked with stays loaded: an explicit
          // load, a lazy tool it called, an authoring skill it loaded, a kept
          // draft or an attached Office file. Decided once, so a later hard
          // truncation in this answer never takes a family away mid-answer.
          if (offeredLazy.length) {
            const retained = new Set(historySuffix.slice(compaction.startIndex).map((m) => m.id));
            for (const call of priorToolCalls)
              if (
                call.researchRunId === null &&
                (retained.has(call.messageId) || call.messageId === input.messageId)
              )
                unlockByCall(unlockedFamilies, call);
            for (const file of kept)
              if (isOfficeFamily(file.owner)) unlockTool(OFFICE_FAMILIES[file.owner].edit);
            const files = yield* promptDeps.attachments.listWithBlobsForMessages([
              ...retained,
              ...ownSteers.map((steer) => steer.id),
            ]);
            for (const file of files) {
              const family = officeFamilyOfFile({ name: file.fileName, mediaType: file.mediaType });
              if (family) unlockTool(OFFICE_FAMILIES[family].edit);
            }
          }

          // Selected knowledge, decided against the exact rendered prompt: the
          // turn-time mode is a ceiling ("context" may still downgrade to
          // retrieval here), never the reverse. Sits after retained history and
          // before the runtime block, itself part of the protected trailing
          // context, so overflow repair drops history turns, not document
          // bodies.
          if (knowledgeSession && config) {
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
                ...historyGroups.slice(compaction.startIndex).flat(),
                ...historyBudgetTail(false),
              ],
              toolSchemaTokens,
              toolResultReserveTokens: knowledgeTools ? KNOWLEDGE_TOOL_LIMITS.resultTokens : 0,
              priorUsage,
            }).pipe(Effect.provideService(KnowledgeService, knowledgeService));
            knowledgeContext = prepared;
            retrievalEnabled = prepared.mode === "retrieval";
            for (const source of prepared.activity?.sources ?? [])
              sourcesByIndex.set(
                source.index,
                mergeSource(sourcesByIndex.get(source.index), source),
              );
            // A resumed answer already shows the row, unless this attempt's
            // context brought sources it lacks.
            const shownContext = ownCalls.filter((call) =>
              call.providerCallId.startsWith("knowledge-context:"),
            );
            const shownIndexes = new Set(
              shownContext.flatMap(
                (call) =>
                  (call.result as { sources?: ReadonlyArray<Source> } | null)?.sources?.map(
                    (source) => source.index,
                  ) ?? [],
              ),
            );
            if (
              prepared.activity &&
              (shownContext.length === 0 ||
                !prepared.activity.sources.every((source) => shownIndexes.has(source.index)))
            ) {
              // Direct context registers its sources like a tool would, through
              // an application-authored activity: replay, reload and branch all
              // render these citations from the same durable row.
              const rowId = uuidv7();
              const position = { turnIndex: firstTurn, callIndex: 0, textOffset: assembled.length };
              yield* repo.insertToolCall({
                id: rowId,
                messageId: input.messageId,
                ...position,
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
                ...position,
              });
              yield* repo.completeToolCall({
                id: rowId,
                result: json(prepared.activity),
                status: "complete",
              });
              yield* pushToolChunk({
                v: 1,
                phase: "result",
                callId: rowId,
                name: "knowledge_context",
                ...prepared.activity,
              });
              contextRowWritten = true;
            }
          }
          const pinnedBefore = new Set(
            ownCalls
              .filter(
                (call) =>
                  call.researchRunId === null && call.providerCallId.startsWith("skill-context:"),
              )
              .map((call) => (call.result as { skillId?: unknown } | null)?.skillId),
          );
          for (const [index, entry] of (config.skills ?? [])
            .filter((entry) => entry.explicit)
            .entries()) {
            // Still pinned in the prompt; only the row a resumed answer shows is not repeated.
            if (pinnedBefore.has(entry.skillId)) continue;
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
              turnIndex: firstTurn,
              callIndex: -5 + index,
              textOffset: assembled.length,
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
              turnIndex: firstTurn,
              callIndex: -5 + index,
              textOffset: assembled.length,
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

          // Direct context reserves the first call slot; model calls start after.
          const firstCallIndex = contextRowWritten ? 1 : 0;

          // Hydrate only the retained suffix after compaction. Subsequent overflow
          // repair can drop these whole units, never resurrect earlier image bytes.
          const retainedHistory = new Map<number, ReadonlyArray<Prompt.MessageEncoded>>();
          const loadedBytes = new Map<string, Uint8Array>();
          for (let index = compaction.startIndex; index < historySuffix.length; index++) {
            const message = historySuffix[index]!;
            retainedHistory.set(index, [
              ...skillReplay(message),
              ...(message.assistantOutput?.files.length ||
              message.providerReplay?.turns.length ||
              steersByAnswer.has(message.id)
                ? yield* buildHistoryMessages(
                    { ...promptDeps, chat: repo },
                    {
                      messages: [message],
                      steers: steersByAnswer,
                      loadedBytes,
                      modelSupportsFiles: model?.capabilities.files ?? false,
                      inlineTextChars: inlineTextCharsFor(model?.contextLength),
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
                : [plainById.get(message.id)!]),
            ]);
          }
          // Two anchors mark where the stable part ends: after the last system
          // message, and after retained history. Everything later is rebuilt
          // per request. The gateway turns them into cache points for providers
          // that cache only where told to.
          const lastSystem = fixedPrefix.map((message) => message.role).lastIndexOf("system");
          const buildBaseTranscript = () => {
            const stable = [
              ...fixedPrefix.map((message, index) =>
                index === lastSystem ? cacheAnchor(message) : message,
              ),
              ...compaction.injectedMessages,
              ...historyMessages
                .slice(compaction.startIndex)
                .flatMap(
                  (message, index) =>
                    retainedHistory.get(index + compaction.startIndex) ?? [message],
                ),
            ];
            const last = stable.length - 1;
            return Prompt.make([
              ...stable.map((message, index) =>
                index === last && index > lastSystem ? cacheAnchor(message) : message,
              ),
              ...startContext(),
            ]);
          };
          let activeSummary: string | null = null;
          // A resumed answer's earlier rounds come first, each one compactable
          // like a round this attempt runs. Its steers sit where they arrived.
          const steerPrompts = ownSteers.length
            ? yield* buildHistoryMessages(promptDeps, {
                messages: ownSteers,
                loadedBytes,
                modelSupportsFiles: model?.capabilities.files ?? false,
                inlineTextChars: inlineTextCharsFor(model?.contextLength),
                modelSupportsVision: model?.capabilities.vision ?? false,
              })
            : [];
          const imageParts = yield* loadResumedImages(promptDeps, {
            messageId: input.messageId,
            files: ownFiles,
            modelSupportsVision: model?.capabilities.vision ?? false,
            loadedBytes,
          });
          let activeRounds: ReadonlyArray<ActiveRound> = resumedRounds({
            content: assembled,
            calls: ownCalls,
            files: ownFiles,
            imageParts,
            replay,
            steers: ownSteers.map((message, index) => ({
              turnIndex: message.steerTurnIndex ?? -1,
              textOffset: message.steerTextOffset ?? 0,
              message: steerPrompts[index]!,
            })),
          }).map((round) => ({ turnIndex: round.turnIndex, prompt: Prompt.make(round.messages) }));
          // The last two completed rounds carry the third and fourth anchors:
          // what follows them (updates, reminders) changes every request, and a
          // round with many results can exceed one anchor's lookback window.
          const buildTranscript = () =>
            compileActivePrompt({
              basePrompt: buildBaseTranscript(),
              summary: activeSummary,
              rounds: activeRounds.map((round, index) =>
                index >= activeRounds.length - 2
                  ? { ...round, prompt: anchorLastMessage(round.prompt) }
                  : round,
              ),
            });

          let transcript = buildTranscript();
          const estimateRequestPrompt = (lastCycle: boolean) => {
            const trailing = reminderPrompt(lastCycle);
            return estimatePromptTokens([
              ...promptMessages(transcript),
              ...(trailing ? promptMessages(trailing) : []),
            ]);
          };
          // Persist the raw estimate of the exact first request. The provider's
          // actual/raw pair then learns one stable calibration multiplier.
          estimatedFirstInputTokens = estimateRequestPrompt(false);
          // Pass indexes are local to one before-turn position. The first turn
          // reserves pass 0 for the initial history planner, emitted or not.
          const nextPassByTurn = new Map<number, number>([[firstTurn, 1]]);
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
          for (let round = 0; round <= roundLimit; round++) {
            // Rows and chunks are keyed by turn, which a resumed answer
            // continues; budgets and first-call logic count this attempt's rounds.
            const turn = firstTurn + round;
            currentRound = round;
            if (round > 0) yield* keepChanges(workingFiles);
            yield* authoring.refresh();
            yield* scheduleAuthoring.refresh();
            yield* documents.refresh();
            // Direct edits can land between calls. Rebuild before budgeting, not
            // just after the previous batch, so the next call sees current data.
            transcript = buildTranscript();
            const factor =
              firstInputTokens !== undefined && estimatedFirstInputTokens !== undefined
                ? calibrationFactor({ firstInputTokens, estimatedFirstInputTokens })
                : calibrationFactor(priorUsage);
            const schemaReserve =
              round < roundLimit ? (schemaTokensWith(unlockedFamilies) ?? 0) : 0;
            while (true) {
              const trailing = reminderPrompt(round >= roundLimit);
              const reduced: ActiveRoundCompactionDecision = yield* prepareCompactedActiveRounds(
                { gateway, repo, providers, analytics },
                {
                  userId: input.userId,
                  conversationId: input.conversationId,
                  messageId: input.messageId,
                  modelId: input.modelId,
                  contextLength: model?.contextLength,
                  toolSchemaTokens: schemaReserve,
                  webToolsEnabled: webTools !== undefined,
                  basePrompt: buildBaseTranscript(),
                  summary: activeSummary,
                  rounds: activeRounds,
                  beforeTurnIndex: turn,
                  textOffset: assembled.length,
                  passIndex: nextPassIndex(turn),
                  calibrationFactor: factor,
                  sourceManifest: sourceManifest(),
                  ...(trailing ? { trailingPrompt: trailing } : {}),
                  onCompaction: (event) => pushCompactionChunk({ v: 1, ...event }),
                  clearOldResults: true,
                  summaryTokens: summaryTokensFor(model?.contextLength),
                },
              );
              if (!reduced.compacted) break;
              activeSummary = reduced.summary;
              activeRounds = reduced.rounds;
              transcript = buildTranscript();
            }
            const requestBudget = computeBudget({
              contextLength: model?.contextLength,
              webToolsEnabled: webTools !== undefined,
              toolSchemaTokens: schemaReserve,
            }).input;
            while (Math.ceil(estimateRequestPrompt(round >= roundLimit) * factor) > requestBudget) {
              const active = compileActivePrompt({
                basePrompt: Prompt.empty,
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
                  ...(active.content as ReadonlyArray<Prompt.MessageEncoded>),
                ],
                trailingMessages: historyBudgetTail(round >= roundLimit),
                calibrationFactor: factor,
              });
              if (!shrunk)
                return yield* new ContextTooLarge({
                  conversationId: input.conversationId,
                  estimatedInputTokens: Math.ceil(
                    estimateRequestPrompt(round >= roundLimit) * factor,
                  ),
                  inputBudget: requestBudget,
                });
              compaction = { ...compaction, ...shrunk, mode: "truncated" };
              syncEarlierSkills(compaction.startIndex);
              transcript = buildTranscript();
              yield* recordHardTruncation(turn);
            }
            if (round === 0) estimatedFirstInputTokens = estimateRequestPrompt(false);
            if (skillTools) yield* skillTools.authorize();
            if (knowledgeTools) yield* knowledgeTools.authorize();
            else if (knowledgeSession) yield* knowledgeSession.authorize();
            const toolRoundsLeft = round < roundLimit;
            let finishReason: Response.FinishReason | undefined;
            let callIndex = round === 0 ? firstCallIndex : 0;
            const turnParts: Response.AnyPart[] = [];
            // Bytes a local read produced for the model this turn. A tool
            // result is text on the wire, so an image or PDF rides as a user
            // file part appended to the round, the way an attachment would.
            const turnFiles: Array<Prompt.UserMessagePartEncoded> = [];
            previewTurnFiles = turnFiles;
            const turnStartOffset = assembled.length;
            // One fenced registration for every file an answer delivers (a
            // publish, a custom tool's output, a shared screenshot): the
            // attachment and its file chunk land together, under the fence.
            const deliverFile = (
              file: { name: string; mediaType: string; bytes: Uint8Array },
              toolCallId: string,
              inTransaction?: (
                tx: DbTx,
                owner: GenerationIdentity,
              ) => Effect.Effect<ReadonlyArray<string>>,
            ) =>
              Effect.gen(function* () {
                if (!fence || Option.isNone(imageAttachments))
                  return { reason: "File delivery is unavailable." } as const;
                yield* flush;
                const accepted = yield* writer.withPermits(1)(
                  acceptGeneratedFile(imageAttachments.value, {
                    fence,
                    fileName: file.name,
                    mediaType: file.mediaType,
                    bytes: file.bytes,
                    origin: { toolCallId },
                    ...(inTransaction
                      ? { inTransaction: (tx: DbTx) => inTransaction(tx, fence) }
                      : {}),
                    textOffset: assembled.length,
                    turnIndex: turn,
                    callIndex,
                    eventIndex: seq + 1,
                    seq: seq + 1,
                  }).pipe(
                    Effect.tap((delivered) =>
                      Effect.gen(function* () {
                        seq += 1;
                        yield* PubSub.publish(pubsub, {
                          kind: "chunk",
                          messageId: input.messageId,
                          runId: fence.generationId,
                          seq,
                          chunkKind: "file",
                          delta: JSON.stringify(delivered),
                        });
                      }),
                    ),
                    Effect.uninterruptible,
                    Effect.result,
                  ),
                );
                return accepted._tag === "Success"
                  ? ({ attachment: accepted.success.attachment } as const)
                  : ({ reason: accepted.failure.reason } as const);
              });
            // provider call id -> our durable row id
            const callRowIds = new Map<string, string>();
            // The argument summary an integration row showed at start, for its result.
            const integrationSummaries = new Map<string, string | null>();
            // Snapshots asked to show their screenshot to the user, by provider call id.
            const sharedSnapshots = new Set<string>();
            turnCallRows.clear();
            let providerOutputStarted = false;
            const currentReminderPrompt = () => reminderPrompt(!toolRoundsLeft);
            const requestPrompt = () => {
              const trailing = currentReminderPrompt();
              return trailing ? Prompt.concat(transcript, trailing) : transcript;
            };

            // Suspended so an overflow retry re-reads the shrunken transcript
            // rather than the one the provider just rejected.
            const drain = Effect.suspend(() => {
              // An answer gets one memory save attempt across all tool rounds,
              // including those an interrupted attempt already ran.
              const activeToolkit =
                memorySpent || memoryTools?.attempted() ? nonMemoryToolkit : toolkit;
              // Unloaded families stay callable but unadvertised: a call to one
              // loads it (see the tool-call observer) instead of failing.
              const advertised = activeToolkit
                ? Object.keys(activeToolkit.tools).filter((name) =>
                    isAdvertised(name, offeredLazy, unlockedFamilies),
                  )
                : [];
              modelCallOpen = true;
              return gateway
                .streamChat({
                  imageOutput,
                  modelId: input.modelId,
                  reasoningEffort: config.reasoningEffort,
                  cacheKey: input.conversationId,
                  // Rebuilt every round and always last: the recap has to sit
                  // behind the tool results it competes with. It is budgeted but
                  // never fed back into the continuation transcript.
                  prompt: requestPrompt(),
                  ...(activeToolkit && toolRoundsLeft
                    ? {
                        toolkit: activeToolkit,
                        toolChoice:
                          advertised.length < Object.keys(activeToolkit.tools).length
                            ? { oneOf: advertised }
                            : ("auto" as const),
                      }
                    : {}),
                })
                .pipe(
                  Stream.mapEffect((part) =>
                    Effect.gen(function* () {
                      // Preliminary tool results are UI progress only, so keep them
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
                              : redactDocumentPart(
                                  redactAgentDraftPart(redactScheduleDraftPart(part)),
                                ),
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
                                    chunkKind: "file",
                                    delta: JSON.stringify(image),
                                  });
                                  return image;
                                }),
                              ),
                              Effect.uninterruptible,
                            ),
                          );
                          turnFiles.push({
                            type: "text",
                            text: attachmentReferenceHint(image.attachment),
                          });
                          acceptedImages += 1;
                          return;
                        }
                        case "text-delta": {
                          pushChunk("text", part.delta);
                          if (buffer.length >= 16) yield* flush;
                          return;
                        }
                        case "reasoning-delta": {
                          // The adapter writes encrypted reasoning as the text
                          // "[REDACTED]"; the encrypted part still rides the
                          // replay, so the reader gets the bare thinking marker.
                          pushChunk("reasoning", part.delta === "[REDACTED]" ? "" : part.delta);
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
                          unlockTool(part.name);
                          if (part.name === "load_skill") {
                            if (args.skillId === "builtin:agent-authoring")
                              unlockTool("draft_agent");
                            if (args.skillId === "builtin:schedule-authoring")
                              unlockTool("draft_schedule");
                          }
                          const family =
                            part.name === "load_tools" && toolLoad
                              ? "tool-load"
                              : part.name === "read_attachment" && attachmentReader
                                ? "attachment"
                                : Schema.is(AgentDraftToolName)(part.name)
                                  ? "agent-draft"
                                  : Schema.is(ScheduleDraftToolName)(part.name)
                                    ? "schedule-draft"
                                    : Schema.is(DocumentToolName)(part.name)
                                      ? "document"
                                      : Schema.is(ProjectFileToolName)(part.name)
                                        ? "project-file"
                                        : Schema.is(DesktopToolName)(part.name)
                                          ? "desktop"
                                          : part.name === "save_memory"
                                            ? "memory"
                                            : part.name === "ask_user"
                                              ? "ask"
                                              : part.name === "update_plan"
                                                ? "plan"
                                                : part.name === "publish_file" && publishFileTool
                                                  ? "tool-file"
                                                  : officeFamilyOf(part.name)
                                                    ? officeFamilyOf(part.name)!.family
                                                    : Schema.is(SkillToolName)(part.name)
                                                      ? "skill"
                                                      : Schema.is(KnowledgeToolName)(part.name)
                                                        ? "knowledge"
                                                        : part.name === "deep_research"
                                                          ? "research"
                                                          : part.name === "web_search" ||
                                                              part.name === "read_url"
                                                            ? "web"
                                                            : customToolNames.has(part.name)
                                                              ? "custom"
                                                              : integrationTools?.names.has(
                                                                    part.name,
                                                                  )
                                                                ? "integration"
                                                                : null;
                          if (!family) return;
                          const rowId = uuidv7();
                          callRowIds.set(part.id, rowId);
                          const askArgs =
                            family === "ask"
                              ? Schema.decodeUnknownOption(AskUserParams)(args)
                              : null;
                          const textOffset = assembled.length;
                          const shownArgs = shownBrowserArgs(part.name, args);
                          if (part.name === "browser_snapshot" && args.share === true)
                            sharedSnapshots.add(part.id);
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
                              family === "memory" ||
                              family === "skill" ||
                              family === "agent-draft" ||
                              family === "schedule-draft" ||
                              family === "document" ||
                              family === "project-file" ||
                              family === "tool-file" ||
                              isOfficeFamily(family) ||
                              family === "research" ||
                              family === "integration"
                                ? {}
                                : family === "ask"
                                  ? askArgs && Option.isSome(askArgs)
                                    ? json(askArgs.value)
                                    : {}
                                  : (shownArgs as JsonValue),
                          });
                          if (family === "research") {
                            // The handler cannot learn its own row id: the
                            // toolkit hands it the provider's call id, and this
                            // row is minted here. It waits on the same handshake
                            // the desktop tools use, then describes its own run.
                            yield* Deferred.succeed(callRowReady(part.id), {
                              rowId,
                              turnIndex: turn,
                              callIndex: callIndex - 1,
                            });
                            return;
                          }
                          const office = officeFamilyOf(part.name);
                          if (office) {
                            yield* pushToolChunk({
                              v: 1,
                              family: office.family,
                              phase: "start",
                              callId: rowId,
                              name: part.name,
                              turnIndex: turn,
                              callIndex: callIndex - 1,
                              textOffset,
                            } as ToolChunkEnvelope);
                            return;
                          }
                          if (family === "tool-file") {
                            yield* pushToolChunk({
                              v: 1,
                              family: "tool-file",
                              phase: "start",
                              callId: rowId,
                              name: "publish_file",
                              turnIndex: turn,
                              callIndex: callIndex - 1,
                              textOffset,
                            });
                            return;
                          }
                          if (family === "attachment") {
                            yield* pushToolChunk({
                              v: 1,
                              family,
                              phase: "start",
                              callId: rowId,
                              name: "read_attachment",
                              turnIndex: turn,
                              callIndex: callIndex - 1,
                              textOffset,
                            });
                            return;
                          }
                          if (family === "tool-load") {
                            yield* pushToolChunk({
                              v: 1,
                              family,
                              phase: "start",
                              callId: rowId,
                              name: "load_tools",
                              turnIndex: turn,
                              callIndex: callIndex - 1,
                              textOffset,
                            });
                            return;
                          }
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
                          if (family === "desktop") {
                            // SDK handlers run concurrently with this observer.
                            // Release them only after the owned registration exists.
                            const ready = callRowReady(part.id);
                            if (!input.desktopExecutorId || !input.generationId) {
                              yield* Deferred.succeed(ready, undefined);
                              return;
                            }
                            yield* external.open(rowId, {
                              userId: input.userId,
                              conversationId: input.conversationId,
                              messageId: input.messageId,
                              generationId: input.generationId,
                              executorId: input.desktopExecutorId,
                              deviceSessionId: input.deviceSessionId,
                              name: part.name,
                              args,
                              // Only the browser needs to know: whether the user's own
                              // text vouched for the address, and whether to keep pages.
                              ...(isBrowserTool(part.name)
                                ? {
                                    meta: {
                                      preauthorized:
                                        typeof args.url === "string" &&
                                        authority.resolve(args.url) !== null,
                                      temporary,
                                    },
                                  }
                                : {}),
                              timeoutMs: approvalKind(part.name as DesktopToolName, args)
                                ? DESKTOP_TIMEOUTS.command
                                : DESKTOP_TIMEOUTS.quick,
                            });
                            yield* Deferred.succeed(ready, {
                              rowId,
                              turnIndex: turn,
                              callIndex: callIndex - 1,
                            });
                            yield* pushToolChunk({
                              v: 1,
                              family,
                              phase: "start",
                              callId: rowId,
                              name: part.name as DesktopToolName,
                              turnIndex: turn,
                              callIndex: callIndex - 1,
                              textOffset,
                              args: shownArgs,
                            });
                            return;
                          }
                          if (family === "agent-draft") {
                            yield* pushToolChunk({
                              v: 1,
                              family,
                              phase: "start",
                              callId: rowId,
                              name: part.name as AgentDraftToolName,
                              turnIndex: turn,
                              callIndex: callIndex - 1,
                              textOffset,
                            });
                            return;
                          }
                          if (family === "schedule-draft") {
                            yield* pushToolChunk({
                              v: 1,
                              family,
                              phase: "start",
                              callId: rowId,
                              name: part.name as ScheduleDraftToolName,
                              turnIndex: turn,
                              callIndex: callIndex - 1,
                              textOffset,
                            });
                            return;
                          }
                          if (family === "document") {
                            yield* pushToolChunk({
                              v: 1,
                              family,
                              phase: "start",
                              callId: rowId,
                              name: part.name as DocumentToolName,
                              turnIndex: turn,
                              callIndex: callIndex - 1,
                              textOffset,
                            });
                            return;
                          }
                          if (family === "project-file") {
                            yield* pushToolChunk({
                              v: 1,
                              family,
                              phase: "start",
                              callId: rowId,
                              name: part.name as ProjectFileToolName,
                              turnIndex: turn,
                              callIndex: callIndex - 1,
                              textOffset,
                            });
                            return;
                          }
                          if (family === "integration") {
                            const entry = integrationTools!.names.get(part.name)!;
                            const summary = entry.tool.summarize(args)?.slice(0, 200) ?? null;
                            integrationSummaries.set(part.id, summary);
                            // The handler may park on an approval, which names
                            // this row; release it only once the row exists.
                            yield* Deferred.succeed(callRowReady(part.id), {
                              rowId,
                              turnIndex: turn,
                              callIndex: callIndex - 1,
                            });
                            yield* pushToolChunk({
                              v: 1,
                              family,
                              phase: "start",
                              callId: rowId,
                              name: part.name,
                              turnIndex: turn,
                              callIndex: callIndex - 1,
                              textOffset,
                              integrationId: entry.integrationId,
                              tool: entry.tool.name,
                              label: entry.tool.label,
                              access: entry.tool.access,
                              summary,
                            });
                            return;
                          }
                          if (family === "custom") {
                            yield* pushToolChunk({
                              v: 1,
                              family,
                              phase: "start",
                              callId: rowId,
                              name: part.name,
                              turnIndex: turn,
                              callIndex: callIndex - 1,
                              textOffset,
                              displayName: customToolDisplayName(part.name),
                            });
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
                          if (part.name === "deep_research") {
                            if (isPreliminary) return;
                            const decoded = Schema.decodeUnknownOption(ResearchToolResult)(
                              part.result,
                            );
                            const result =
                              !part.isFailure && Option.isSome(decoded)
                                ? decoded.value
                                : ({ outcome: "failed" } as ResearchToolResult);
                            const run =
                              result.runId && repo.research
                                ? yield* repo.research.get(result.runId)
                                : null;
                            // Only evidence is a usable answer. A run that
                            // produced none has already recorded why.
                            const ok = result.outcome === "evidence";
                            // The run wrote this row's body as it went. Settling
                            // the call must not replace the progress and sources
                            // the panel reads back on reload.
                            yield* repo.settleToolCall({
                              id: rowId,
                              status: ok ? "complete" : "error",
                              ...(ok
                                ? {}
                                : {
                                    error: {
                                      code: "ResearchIncomplete",
                                      message: result.message ?? "Research produced no evidence.",
                                    },
                                  }),
                            });
                            if (run)
                              yield* pushToolChunk({
                                v: 1,
                                family: "research",
                                phase: "result",
                                callId: rowId,
                                runId: run.id,
                                name: "deep_research",
                                turnIndex: turn,
                                callIndex: callIndex - 1,
                                textOffset: 0,
                                progress: run.progress,
                              });
                            return;
                          }
                          // This branch and the document one below it are the same
                          // eight steps with different words. They stay apart on
                          // purpose: the envelope union correlates `family` with
                          // the activity shape, and one parameterised path can
                          // only satisfy it through a cast.
                          if (Schema.is(AgentDraftToolName)(part.name)) {
                            if (isPreliminary) return;
                            const activity = projectAgentDraftResult(
                              part.isFailure ? null : part.result,
                            );
                            // The reason is the handler's own sentence, kept so a
                            // "not updated" row can be explained later. A failed
                            // part carries driver output and gets a fixed message.
                            const reason = part.isFailure
                              ? "The draft tool failed before it could respond."
                              : agentDraftFailureReason(part.result);
                            yield* repo.completeToolCall({
                              id: rowId,
                              result: json(activity),
                              status: agentDraftResultOk(activity) ? "complete" : "error",
                              ...(reason
                                ? { error: { code: "AgentDraftNotUpdated", message: reason } }
                                : {}),
                            });
                            yield* pushToolChunk({
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
                          if (Schema.is(ScheduleDraftToolName)(part.name)) {
                            if (isPreliminary) return;
                            const activity = projectScheduleDraftResult(
                              part.isFailure ? null : part.result,
                            );
                            const reason = part.isFailure
                              ? "The draft tool failed before it could respond."
                              : scheduleDraftFailureReason(part.result);
                            yield* repo.completeToolCall({
                              id: rowId,
                              result: json(activity),
                              status: scheduleDraftResultOk(activity) ? "complete" : "error",
                              ...(reason
                                ? { error: { code: "ScheduleDraftNotUpdated", message: reason } }
                                : {}),
                            });
                            yield* pushToolChunk({
                              v: 1,
                              family: "schedule-draft",
                              phase: "result",
                              callId: rowId,
                              name: part.name,
                              ...activity,
                              ...(reason ? { reason } : {}),
                            });
                            return;
                          }
                          if (Schema.is(DocumentToolName)(part.name)) {
                            if (isPreliminary) return;
                            const activity = projectDocumentResult(
                              part.isFailure ? null : part.result,
                            );
                            const reason = part.isFailure
                              ? "The document tool failed before it could respond."
                              : documentFailureReason(part.result);
                            yield* repo.completeToolCall({
                              id: rowId,
                              result: json(activity),
                              status: documentResultOk(activity) ? "complete" : "error",
                              ...(reason
                                ? { error: { code: "DocumentNotUpdated", message: reason } }
                                : {}),
                            });
                            yield* pushToolChunk({
                              v: 1,
                              family: "document",
                              phase: "result",
                              callId: rowId,
                              name: part.name,
                              ...activity,
                              ...(reason ? { reason } : {}),
                            });
                            return;
                          }
                          if (Schema.is(ProjectFileToolName)(part.name)) {
                            if (isPreliminary) return;
                            // File text the model read stays in this answer's
                            // rounds; the row keeps which file and version.
                            const activity = projectProjectFileResult(
                              part.isFailure ? null : part.result,
                            );
                            const reason = part.isFailure
                              ? "The project file tool failed before it could respond."
                              : projectFileFailureReason(part.result);
                            yield* repo.completeToolCall({
                              id: rowId,
                              result: json(activity),
                              status: projectFileResultOk(activity) ? "complete" : "error",
                              ...(reason
                                ? { error: { code: "ProjectFileNotUsed", message: reason } }
                                : {}),
                            });
                            yield* pushToolChunk({
                              v: 1,
                              family: "project-file",
                              phase: "result",
                              callId: rowId,
                              name: part.name,
                              ...activity,
                              ...(reason ? { reason } : {}),
                            });
                            return;
                          }
                          if (Schema.is(DesktopToolName)(part.name)) {
                            if (isPreliminary) return;
                            const decoded = Schema.decodeUnknownOption(DesktopToolResult)(
                              part.result,
                            );
                            // Already capped and sniffed where it came in
                            // (`acceptDesktopToolResult` in the submit function);
                            // here it only has to be the shape the handler promised.
                            const result: DesktopToolResult =
                              !part.isFailure && Option.isSome(decoded)
                                ? decoded.value
                                : {
                                    v: 1,
                                    ok: false,
                                    summary: "That did not run",
                                    detail: "The computer did not report a usable result.",
                                    truncated: false,
                                  };
                            // Every file a machine tool returns becomes a working
                            // file of this attempt, for other tools and for
                            // publish_file, the only way one is stored. Anything
                            // but an import is also shown to the model when it can
                            // take that kind (docs/internals/files.md).
                            const returned = result.ok ? result.file : undefined;
                            const imported = part.name === "import_local_file";
                            const created = returned
                              ? yield* Effect.try({
                                  try: () =>
                                    workingFiles.create({
                                      bytes: new Uint8Array(Buffer.from(returned.base64, "base64")),
                                      name: returned.name,
                                      mediaType: returned.mediaType,
                                      owner: "local",
                                      capture: !imported,
                                    }),
                                  catch: (error) =>
                                    error instanceof Error ? error.message : "Could not keep it.",
                                }).pipe(
                                  Effect.map((file) => ({ reference: formatFileRef(file.ref) })),
                                  Effect.catch((failure) => Effect.succeed({ failure })),
                                )
                              : null;
                            // A screenshot the model asked to show is delivered at
                            // once, like any file the answer publishes.
                            const shared =
                              returned && sharedSnapshots.delete(part.id)
                                ? yield* deliverFile(
                                    {
                                      name: returned.name,
                                      mediaType: returned.mediaType,
                                      bytes: new Uint8Array(Buffer.from(returned.base64, "base64")),
                                    },
                                    rowId,
                                  )
                                : null;
                            const { file: _bytes, ...rest } = result;
                            const answer: DesktopToolResult =
                              created && "reference" in created
                                ? {
                                    ...rest,
                                    // First, not after a page's long outline: read there
                                    // and kept in the row's excerpt.
                                    detail: `${returnedLine(part.name, created.reference, shared)}\n${rest.detail}`,
                                  }
                                : created && imported
                                  ? {
                                      v: 1,
                                      ok: false,
                                      summary: "That file could not be imported",
                                      detail: created.failure,
                                      truncated: false,
                                    }
                                  : imported && result.ok
                                    ? {
                                        v: 1,
                                        ok: false,
                                        summary: "That file could not be imported",
                                        detail: result.detail,
                                        truncated: false,
                                      }
                                    : created
                                      ? {
                                          ...rest,
                                          detail: `${rest.detail}\n(It could not be kept for other tools or publishing: ${created.failure})`,
                                        }
                                      : rest;
                            // The bytes leave the result first, so nothing below can
                            // leave them in the prompt as text: the file part is
                            // their only route to the model.
                            Object.assign(part, { result: answer, encodedResult: answer });
                            if (
                              returned &&
                              !imported &&
                              attachmentKind(returned.mediaType) !== "file"
                            )
                              turnFiles.push(
                                yield* fileForModel(promptDeps.parser, {
                                  ...(created && "reference" in created
                                    ? { id: created.reference }
                                    : {}),
                                  fileName: returned.name,
                                  mediaType: returned.mediaType,
                                  bytes: Buffer.from(returned.base64, "base64"),
                                  vision: model?.capabilities.vision ?? false,
                                  files: model?.capabilities.files ?? false,
                                }),
                              );
                            const stored = forTranscript(answer);
                            // The model reads the full detail through the
                            // prompt; the row and the chunk keep an excerpt.
                            yield* repo.completeToolCall({
                              id: rowId,
                              result: json(stored),
                              status: answer.ok ? "complete" : "error",
                              ...(answer.ok
                                ? {}
                                : {
                                    error: { code: "DesktopToolFailed", message: answer.summary },
                                  }),
                            });
                            yield* pushToolChunk({
                              v: 1,
                              family: "desktop",
                              phase: "result",
                              callId: rowId,
                              name: part.name,
                              result: stored,
                            });
                            return;
                          }
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
                              result: json(result),
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
                          const office = officeFamilyOf(part.name);
                          if (office) {
                            if (isPreliminary) return;
                            const activity = office.summary(part.result, part.isFailure);
                            const { outcome, message } = activity;
                            yield* repo.completeToolCall({
                              id: rowId,
                              result: json(activity),
                              status: outcome === "error" ? "error" : "complete",
                              ...(outcome === "error"
                                ? { error: { code: office.failure, message } }
                                : {}),
                            });
                            yield* pushToolChunk({
                              v: 1,
                              family: office.family,
                              phase: "result",
                              callId: rowId,
                              name: part.name,
                              ...activity,
                            } as ToolChunkEnvelope);
                            return;
                          }
                          if (part.name === "publish_file" && publishFileTool) {
                            if (isPreliminary) return;
                            const pending = publishFileTool.take(part.id);
                            const raw = Option.getOrUndefined(
                              Schema.decodeUnknownOption(ToolFileActivity)(part.result),
                            );
                            let attachmentId = raw?.attachmentId;
                            let error = raw?.error;
                            if (pending) {
                              if (part.isFailure) {
                                error = "File publication was interrupted.";
                              } else if (
                                pending.file.source !== undefined &&
                                !(toolFiles && (yield* toolFiles.authorize(pending.file.source)))
                              ) {
                                error =
                                  "The file this draft was opened from is no longer available.";
                              } else {
                                const delivered = yield* deliverFile(
                                  { ...pending.file, name: pending.name },
                                  rowId,
                                  // Delivered and no longer a draft, in one commit.
                                  keptFiles
                                    ? (tx, owner) => keptFiles.consume(tx, owner, pending.ref.id)
                                    : undefined,
                                );
                                if ("attachment" in delivered)
                                  attachmentId = delivered.attachment.id;
                                else error = delivered.reason;
                              }
                              workingFiles.finishPublish(pending.ref, attachmentId);
                            }
                            const ok = !part.isFailure && !error && !!attachmentId;
                            const publishedRef = raw?.ref ? parseFileRef(raw.ref) : null;
                            const workingFileId =
                              publishedRef?.kind === "working" ? publishedRef.id : undefined;
                            const result: ToolFileActivity = {
                              ok,
                              ...(raw?.ref ? { ref: raw.ref } : {}),
                              ...(workingFileId ? { workingFileId } : {}),
                              ...(attachmentId ? { attachmentId } : {}),
                              ...(!ok ? { error: error ?? "Publication failed." } : {}),
                            };
                            Object.assign(part, { result, encodedResult: result });
                            yield* repo.completeToolCall({
                              id: rowId,
                              result: json(result),
                              status: ok ? "complete" : "error",
                              ...(!ok
                                ? {
                                    error: {
                                      code: "PublicationFailed",
                                      message: result.error ?? "Publication failed.",
                                    },
                                  }
                                : {}),
                            });
                            yield* pushToolChunk({
                              v: 1,
                              family: "tool-file",
                              phase: "result",
                              callId: rowId,
                              name: "publish_file",
                              ...result,
                            });
                            return;
                          }
                          if (part.name === "read_attachment") {
                            if (isPreliminary) return;
                            // The text went to the model; the row keeps which part was read.
                            const activity = part.isFailure
                              ? { ok: false, error: "The file could not be read." }
                              : attachmentReadActivity(part.result);
                            yield* repo.completeToolCall({
                              id: rowId,
                              result: json(activity),
                              status: activity.ok ? "complete" : "error",
                              ...(activity.ok
                                ? {}
                                : {
                                    error: {
                                      code: "AttachmentReadFailed",
                                      message: activity.error ?? "The file could not be read.",
                                    },
                                  }),
                            });
                            yield* pushToolChunk({
                              v: 1,
                              family: "attachment",
                              phase: "result",
                              callId: rowId,
                              name: "read_attachment",
                              ...activity,
                            });
                            return;
                          }
                          if (part.name === "load_tools") {
                            if (isPreliminary) return;
                            const decoded = Schema.decodeUnknownOption(LoadToolsResult)(
                              part.result,
                            );
                            const ok = !part.isFailure && Option.isSome(decoded);
                            yield* repo.completeToolCall({
                              id: rowId,
                              result: ok ? json(decoded.value) : null,
                              status: ok ? "complete" : "error",
                              ...(ok
                                ? {}
                                : {
                                    error: {
                                      code: "ToolLoadFailed",
                                      message: "The tools could not be loaded.",
                                    },
                                  }),
                            });
                            yield* pushToolChunk({
                              v: 1,
                              family: "tool-load",
                              phase: "result",
                              callId: rowId,
                              name: "load_tools",
                              ok,
                              ...(ok ? { loaded: decoded.value.loaded } : {}),
                            });
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
                              result: json(result),
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
                            const decodedMemory = Schema.decodeUnknownOption(SaveMemoryResult)(
                              part.result,
                            );
                            const result = Option.getOrUndefined(decodedMemory);
                            const outcome = result?.outcome ?? "rejected";
                            const reason = result?.reason;
                            const scope =
                              result?.scope === "project" ? { scope: "project" as const } : {};
                            const ok = !part.isFailure && result?.ok === true;
                            yield* repo.completeToolCall({
                              id: rowId,
                              result: { outcome, ...(reason ? { reason } : {}), ...scope },
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
                              ...(reason ? { reason } : {}),
                              ...scope,
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
                              result: json(activity),
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
                              result: json(activity),
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

                          const integrationEntry = integrationTools?.names.get(part.name);
                          if (integrationEntry) {
                            if (isPreliminary) return;
                            const sources = integrationTools!.takeSources(part.id);
                            for (const source of sources)
                              sourcesByIndex.set(
                                source.index,
                                mergeSource(sourcesByIndex.get(source.index), source),
                              );
                            const activity = projectIntegrationToolResult({
                              name: part.name,
                              integrationId: integrationEntry.integrationId,
                              tool: integrationEntry.tool.name,
                              label: integrationEntry.tool.label,
                              access: integrationEntry.tool.access,
                              summary: integrationSummaries.get(part.id) ?? null,
                              raw: part.result,
                              isFailure: part.isFailure,
                              sources,
                            });
                            yield* repo.completeToolCall({
                              id: rowId,
                              result: json(activity),
                              status: activity.status === "complete" ? "complete" : "error",
                              ...(activity.error
                                ? {
                                    error: {
                                      code:
                                        activity.status === "refused"
                                          ? "IntegrationRefused"
                                          : "IntegrationFailed",
                                      message: activity.error,
                                    },
                                  }
                                : {}),
                            });
                            yield* pushToolChunk({
                              v: 1,
                              family: "integration",
                              phase: "result",
                              callId: rowId,
                              name: part.name,
                              activity,
                            });
                            return;
                          }

                          if (customToolNames.has(part.name)) {
                            if (isPreliminary) return;
                            const fileIds: string[] = [];
                            const workingOutputs: Array<{
                              id: string;
                              revision: number;
                              name: string;
                            }> = [];
                            const outcomes: Array<Record<string, unknown>> = [];
                            const errors: string[] = [];
                            const owner = customToolOwners.get(part.name)!;
                            for (const item of customTools?.takeFiles(part.id) ?? []) {
                              if (item.delivery === "working") {
                                const committed = yield* Effect.try({
                                  try: () =>
                                    item.replaces
                                      ? workingFiles.replace(item.replaces, { ...item, owner })
                                      : workingFiles.create({ ...item, owner }),
                                  catch: (cause) =>
                                    cause instanceof Error ? cause.message : String(cause),
                                }).pipe(Effect.result);
                                if (committed._tag === "Failure") {
                                  errors.push(`${item.name}: ${committed.failure}`);
                                  outcomes.push({ error: committed.failure });
                                  continue;
                                }
                                const ref = formatFileRef(committed.success.ref);
                                workingOutputs.push({
                                  id: committed.success.ref.id,
                                  revision: committed.success.ref.revision,
                                  name: item.name,
                                });
                                outcomes.push({ ref, revision: committed.success.ref.revision });
                                if (item.showModel)
                                  turnFiles.push(
                                    yield* fileForModel(promptDeps.parser, {
                                      id: ref,
                                      fileName: item.name,
                                      mediaType: committed.success.mediaType,
                                      bytes: item.bytes,
                                      vision: model?.capabilities.vision ?? false,
                                      files: model?.capabilities.files ?? false,
                                    }),
                                  );
                                continue;
                              }
                              const stored = yield* deliverFile(item, rowId);
                              if ("reason" in stored) {
                                errors.push(`${item.name}: ${stored.reason}`);
                                outcomes.push({ error: stored.reason });
                                continue;
                              }
                              fileIds.push(stored.attachment.id);
                              outcomes.push({
                                attachmentId: stored.attachment.id,
                                ref: formatFileRef({
                                  kind: "attachment",
                                  id: stored.attachment.id,
                                }),
                              });
                              if (item.showModel)
                                turnFiles.push(
                                  yield* fileForModel(promptDeps.parser, {
                                    id: stored.attachment.id,
                                    fileName: item.name,
                                    mediaType: stored.attachment.mediaType,
                                    bytes: item.bytes,
                                    vision: model?.capabilities.vision ?? false,
                                    files: model?.capabilities.files ?? false,
                                  }),
                                );
                            }
                            if (outcomes.length > 0) {
                              const result = part.result as {
                                files?: ReadonlyArray<{ name: string }>;
                              };
                              const delivered = {
                                ...result,
                                ...(errors.length
                                  ? { ok: false, error: errors.join("; ").slice(0, 500) }
                                  : {}),
                                files: (result.files ?? []).map((file, index) => ({
                                  ...file,
                                  ...outcomes[index],
                                })),
                              };
                              Object.assign(part, { result: delivered, encodedResult: delivered });
                            }
                            const activity = projectCustomToolResult({
                              name: part.name,
                              displayName: customToolDisplayName(part.name),
                              raw: part.result,
                              isFailure: part.isFailure,
                              fileIds,
                              workingFiles: workingOutputs,
                            });
                            yield* repo.completeToolCall({
                              id: rowId,
                              result: json(activity),
                              status: activity.status === "complete" ? "complete" : "error",
                              ...(activity.error
                                ? { error: { code: "CustomToolFailed", message: activity.error } }
                                : {}),
                            });
                            yield* pushToolChunk({
                              v: 1,
                              family: "custom",
                              phase: "result",
                              callId: rowId,
                              name: part.name,
                              displayName: activity.displayName,
                              status: activity.status === "complete" ? "complete" : "error",
                              ...(activity.resultPreview !== undefined
                                ? { resultPreview: activity.resultPreview }
                                : {}),
                              ...(activity.resultChars !== undefined
                                ? { resultChars: activity.resultChars }
                                : {}),
                              ...(activity.error ? { error: activity.error } : {}),
                              ...(activity.fileIds ? { fileIds: activity.fileIds } : {}),
                              ...(activity.workingFiles
                                ? { workingFiles: activity.workingFiles }
                                : {}),
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
                          // Persist summary + source list only, never page bodies.
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
                            result: json({
                              ...summary,
                              ...(pages.length > 0 ? { pages } : {}),
                              ...(sources.length > 0 ? { sources } : {}),
                              ...(failures.length > 0 ? { failures } : {}),
                            }),
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
                        // An edit_document call's arguments, as they stream: the
                        // open document shows the edit being written. The
                        // decoded call settles it.
                        case "tool-params-start":
                          documents.live.start(part.id, part.name);
                          // An Office edit is one long call the model can spend
                          // minutes writing; say so before it completes.
                          if (officeFamilyOfEdit(part.name)) {
                            pushChunk(
                              "writing",
                              JSON.stringify({
                                v: 1,
                                id: part.id,
                                name: part.name,
                                textOffset: assembled.length,
                                turnIndex: turn,
                                // A resumed answer replays this chunk; the attempt
                                // it names tells the client it is no longer writing.
                                ...(fence ? { runId: fence.generationId } : {}),
                              }),
                            );
                            yield* flush;
                          }
                          return;
                        case "tool-params-delta":
                          yield* documents.live.delta(part.id, part.delta);
                          return;
                        default:
                          return;
                      }
                    }),
                  ),
                  Stream.runDrain,
                  Effect.ensuring(documents.live.close),
                );
            });

            const currentCalibration = () =>
              firstInputTokens !== undefined && estimatedFirstInputTokens !== undefined
                ? calibrationFactor({ firstInputTokens, estimatedFirstInputTokens })
                : calibrationFactor(priorUsage);

            // Two bounded recovery stages: first reduce complete active rounds,
            // then old history. A retry remains safe only while this provider
            // call has emitted no user-visible or tool output.
            const runProviderCall = (
              recoveryStage: number,
            ): Effect.Effect<void, unknown, Scope.Scope> =>
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
                            toolSchemaTokens: schemaReserve,
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
                            summaryTokens: summaryTokensFor(model?.contextLength),
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
                      fixedPrefix: [...fixedPrefix, ...promptMessages(activeOnly)],
                      trailingMessages: historyBudgetTail(!toolRoundsLeft),
                      calibrationFactor: factor,
                    });
                    if (!shrunk) return yield* Effect.fail(error);

                    compaction = { ...compaction, ...shrunk, mode: "truncated" };
                    syncEarlierSkills(compaction.startIndex);
                    transcript = buildTranscript();
                    if (round === 0) {
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
            // Presenting questions ends the response: entries aimed at this
            // generation stay queued so the answer owns the next turn.
            if (questionPresented) break;
            // The answer is done: a steer that did not reach a boundary stays
            // queued, first in line, and goes out as the next turn. It is never
            // bolted onto an answer that already finished.
            if (finishReason !== "tool-calls") break;
            // The only safe point: every tool result of this round is terminal
            // and the model is about to be called again anyway, so nothing in
            // flight is cut short. The last round has no call after it.
            const steered =
              fence && round < roundLimit
                ? yield* repo.claimSteeredEntries({
                    conversationId: input.conversationId,
                    messageId: input.messageId,
                    textOffset: assembled.length,
                    turnIndex: turn,
                  })
                : [];
            // A completed response/tool batch is one atomic unit. It becomes
            // eligible for compaction only now, after every tool result is
            // terminal; no call can ever be separated from its result.
            const roundPrompt = imageOutput
              ? responseTurnPrompt(turnParts)
              : Prompt.fromResponseParts(turnParts);
            activeRounds = [
              ...activeRounds,
              {
                turnIndex: turn,
                prompt:
                  turnFiles.length === 0
                    ? roundPrompt
                    : Prompt.concat(
                        roundPrompt,
                        Prompt.make([{ role: "user", content: turnFiles }]),
                      ),
              },
            ];
            if (steered.length > 0) {
              steeredAfter = round;
              // Built exactly as history builds a user message, so a steered
              // file reaches the model the way an attached one does: native
              // when it can read it, extracted text when it cannot.
              const steeredPrompt = yield* buildHistoryMessages(promptDeps, {
                messages: steered,
                loadedBytes,
                modelSupportsFiles: model?.capabilities.files ?? false,
                inlineTextChars: inlineTextCharsFor(model?.contextLength),
                modelSupportsVision: model?.capabilities.vision ?? false,
              });
              activeRounds = [
                ...activeRounds,
                { turnIndex: turn, prompt: Prompt.make(steeredPrompt) },
              ];
              // In the stream at the moment it was taken in, persisted before
              // it is published, so the answer shows it in order live and a
              // resume replays it in the same place.
              const files = yield* attachments.listWithBlobsForMessages(
                steered.map((message) => message.id),
              );
              for (const message of steered) {
                const envelope: SteerChunkEnvelope = {
                  v: 1,
                  id: message.id,
                  queueEntryId: message.queueEntryId,
                  content: message.content,
                  textOffset: message.steerTextOffset ?? assembled.length,
                  turnIndex: message.steerTurnIndex ?? turn,
                  attachments: files
                    .filter((file) => file.messageId === message.id)
                    .map(toAttachmentDto),
                };
                pushChunk("steer", JSON.stringify(envelope));
              }
              yield* flush;
              yield* Effect.forEach(
                steered,
                (message) =>
                  sync.publish(input.userId, {
                    type: "message.created",
                    conversationId: input.conversationId,
                    messageId: message.id,
                  }),
                { discard: true },
              );
              yield* sync.publish(input.userId, {
                type: "conversation.queue.changed",
                conversationId: input.conversationId,
              });
            }
            transcript = buildTranscript();
          }
          // Internal tool rounds need no prose. A validated question is itself the
          // answer; research returns through its own runner before this chat loop.
          // A resumed answer starts from its earlier text, so it is never empty.
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
          Effect.onInterrupt(() => finalize("error")),
        );
      });

      const startGeneration = Effect.fn("StreamEngine.startGeneration")(function* (input: {
        userId: string;
        conversationId: string;
        messageId: string;
        modelId: string;
        searchEnabled: boolean;
        generationId?: string | undefined;
        desktopExecutorId?: string | undefined;
        deviceSessionId?: string | undefined;
        timeZone?: string | undefined;
        openDocumentId?: string | undefined;
        resume?: boolean | undefined;
        onSettled?: (input: {
          userId: string;
          conversationId: string;
          messageId: string;
          status: "complete" | "error" | "aborted";
        }) => Effect.Effect<void>;
      }) {
        const abort = yield* Deferred.make<void>();
        const message = yield* repo.getMessage(input.messageId);
        if (!input.generationId || message?.generationId !== input.generationId) return;
        const fence: GenerationIdentity | null = input.generationId
          ? {
              userId: input.userId,
              conversationId: input.conversationId,
              messageId: input.messageId,
              generationId: input.generationId,
            }
          : null;
        const owner: ExternalOwner | null =
          input.desktopExecutorId && input.generationId
            ? {
                userId: input.userId,
                conversationId: input.conversationId,
                messageId: input.messageId,
                generationId: input.generationId,
                executorId: input.desktopExecutorId,
                deviceSessionId: input.deviceSessionId,
              }
            : null;
        const registration = {
          abort,
          settled: yield* Deferred.make<void>(),
          runId: fence?.generationId,
          owner,
        };
        inFlight.set(input.messageId, registration);
        // Detached from the request fiber: survives the HTTP response ending.
        yield* Effect.forkIn(
          Effect.gen(function* () {
            if (owner)
              yield* external.track(
                owner,
                sync.publish(input.userId, { type: "desktop.work.changed" }),
              );
            yield* runGeneration({ ...input, abort });
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                yield* Effect.logError("generation startup failed", cause);
                const current = yield* repo.getMessage(input.messageId);
                if (current?.status !== "streaming" || current.generationId !== input.generationId)
                  return;
                yield* repo.failGeneration({
                  messageId: input.messageId,
                  error: shortErrorMessage(cause),
                  ledger: {
                    userId: input.userId,
                    kind: "chat",
                    modelId: null,
                    modelName: input.modelId,
                    conversationId: input.conversationId,
                    messageId: input.messageId,
                    status: "error",
                    inputTokens: 0,
                    outputTokens: 0,
                    cachedInputTokens: 0,
                    reasoningTokens: 0,
                    usageComplete: false,
                    cost: null,
                    costSource: null,
                  },
                });
                yield* PubSub.publish(pubsub, {
                  kind: "done",
                  messageId: input.messageId,
                  ...(input.generationId ? { runId: input.generationId } : {}),
                  status: "error",
                });
                yield* sync.publish(input.userId, {
                  type: "message.status",
                  conversationId: input.conversationId,
                  messageId: input.messageId,
                  status: "error",
                });
                yield* (input.onSettled ?? (() => Effect.void))({
                  userId: input.userId,
                  conversationId: input.conversationId,
                  messageId: input.messageId,
                  status: "error",
                });
              }),
            ),
            Effect.scoped,
            Effect.provideService(GenerationFence, fence),
            Effect.provideService(GenerationSettled, input.onSettled ?? (() => Effect.void)),
            Effect.ensuring(
              Deferred.succeed(registration.settled, undefined).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    // Identity-checked: a retry reuses the message id, so this
                    // run must not evict the registration a newer one made.
                    if (inFlight.get(input.messageId) === registration)
                      inFlight.delete(input.messageId);
                  }),
                ),
              ),
            ),
          ),
          runtimeScope,
        );
      });

      const stopGeneration = (messageId: string, expectedRunId?: string): Effect.Effect<boolean> =>
        Effect.suspend(() => {
          const registration = inFlight.get(messageId);
          if (!registration || registration.runId !== expectedRunId) return Effect.succeed(false);
          return Deferred.succeed(registration.abort, undefined).pipe(
            Effect.tap(() =>
              registration.owner ? external.cancelAttempt(registration.owner) : Effect.void,
            ),
          );
        });

      const awaitSettled = (messageId: string, expectedRunId?: string): Effect.Effect<void> =>
        Effect.suspend(() => {
          const registration = inFlight.get(messageId);
          if (!registration || registration.runId !== expectedRunId) return Effect.void;
          return Deferred.await(registration.settled);
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
            const message = yield* repo.getMessage(messageId).pipe(Effect.orDie);
            if (!message) {
              const done: StreamEvent = { kind: "done", messageId, status: "error" };
              return Stream.make(done);
            }

            const subscription = yield* PubSub.subscribe(pubsub);
            if (message.status === "streaming" && !inFlight.has(messageId)) yield* reapGenerations;
            const current = (yield* repo.getMessage(messageId).pipe(Effect.orDie)) ?? message;
            const runId = expectedRunId ?? current.generationId ?? undefined;
            if (current.generationId && current.generationId !== runId)
              return Stream.make({
                kind: "done" as const,
                messageId,
                runId: current.generationId,
                status: "error" as const,
              });
            const persisted = yield* repo.chunksAfter(messageId, afterSeq);
            // Retry replaces chunks and identity atomically. Check again before
            // labeling replay, so rows read across that commit cannot be mixed.
            const afterReplay = yield* repo.getMessage(messageId).pipe(Effect.orDie);
            if (!afterReplay || afterReplay.generationId !== current.generationId)
              return Stream.make({
                kind: "done" as const,
                messageId,
                ...(afterReplay?.generationId ? { runId: afterReplay.generationId } : {}),
                status: "error" as const,
              });
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

      return StreamEngine.of({
        startGeneration,
        stopGeneration,
        awaitSettled,
        reapOrphans: reapGenerations,
        subscribe,
      });
    }),
  ).pipe(
    Layer.provideMerge(ScheduleDraftService.layer),
    Layer.provideMerge(AgentDraftService.layer),
    Layer.provideMerge(DocumentService.layer),
    Layer.provideMerge(ProjectMemoryService.layer),
    Layer.provideMerge(AgentRepo.layer),
    Layer.provideMerge(KnowledgeRepo.layer),
    Layer.provideMerge(SkillReader.layer),
  );
}
