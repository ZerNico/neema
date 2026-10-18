import type { ExternalOwner } from "~/modules/tools/server/external-completion.ts";
import { desktopToolTimeout, unusableDesktopResult } from "~/modules/desktop/tool-schema.ts";
import { AgentDraftService } from "~/modules/agents/server/draft-service.ts";
import { DocumentService } from "~/modules/documents/server/document-service.ts";
import {
  ProjectFileToolName,
  projectFileFailureReason,
  projectFileResultOk,
  projectProjectFileResult,
} from "~/modules/projects/file-tool-schema.ts";
import { ProjectMemoryService } from "~/modules/projects/server/project-memory.ts";
import { ResearchToolResult } from "./research/tool.ts";

import {
  DocumentToolName,
  documentFailureReason,
  projectDocumentResult,
  documentResultOk,
  redactDocumentPart,
  isDocumentWrite,
} from "~/modules/documents/tool-schema.ts";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import {
  AgentDraftToolName,
  agentDraftFailureReason,
  projectAgentDraftResult,
  agentDraftResultOk,
  redactAgentDraftPart,
} from "~/modules/agents/tool-schema.ts";
import { ScheduleDraftService } from "~/modules/schedules/server/draft-service.ts";
import {
  ScheduleDraftToolName,
  projectScheduleDraftResult,
  redactScheduleDraftPart,
  scheduleDraftFailureReason,
  scheduleDraftResultOk,
} from "~/modules/schedules/tool-schema.ts";
import { KnowledgeRepo } from "~/modules/knowledge/server/repo.ts";
import { SkillReader } from "~/modules/skills/server/reader.ts";
import { SKILL_LIMITS } from "~/modules/skills/package.ts";
import { earlierSkillMessage } from "~/modules/skills/server/tools.ts";
import { SkillToolName, projectSkillToolResult } from "~/modules/skills/tool-schema.ts";
import {
  isOfficeFamily,
  officeFamilyOfEdit,
  officeFamilyOfFile,
} from "~/modules/office/families.ts";
import { attachmentKind } from "~/modules/attachments/constants.ts";
import { acceptGeneratedFile, acceptGeneratedImage } from "./generated-files.ts";
import { lookupsOf } from "../assistant-output.ts";
import { INTERACTIVE_UI_SKILL_ID } from "~/modules/genui/skill.ts";
import {
  MAP_ROUTE_TOOL,
  MapRouteResult,
  summarizeMapRoute,
} from "~/modules/genui/map-tool-schema.ts";
import { fileForModel } from "./file-for-model.ts";
import { attachmentReferenceHint } from "../file-references.ts";
import { GenerationFence, GenerationSettled, type GenerationIdentity } from "./generation-fence.ts";
import { appendReplay, replayUnitOf } from "./provider-replay.ts";
import { type ImageQuality, replayOf, roundPrompt } from "@chat/model-client";
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  PubSub,
  Schedule,
  Schema,
  Stream,
  type Scope,
} from "effect";
import {
  AskUserParams,
  AskUserResult,
  formatQuestionContext,
  readPresentedQuestions,
} from "~/modules/tools/ask-user-schema.ts";
import { PlanToolResult, renderPlanReminder } from "~/modules/tools/plan-schema.ts";
import { Prompt, type Response } from "effect/unstable/ai";
import { uuidv7 } from "uuidv7";
import { addFinishUsage, providerCostOf } from "~/modules/analytics/server/usage.ts";
import { formatFileRef, parseFileRef } from "./file-ref.ts";
import type { OpenDocument } from "../schema.ts";
import { ToolFileActivity } from "../tool-file-schema.ts";
import { toAttachmentDto, type DbTx } from "~/modules/attachments/server/repo.ts";
import {
  ProviderContextOverflow,
  anchorLastMessage,
  cacheAnchor,
} from "~/modules/providers/server/gateway.ts";
import { SaveMemoryResult } from "~/modules/memory/server/memory-tool.ts";
import {
  prepareKnowledgeContext,
  type PreparedKnowledgeContext,
} from "~/modules/knowledge/server/context.ts";
import { KnowledgeService } from "~/modules/knowledge/server/service.ts";
import {
  KNOWLEDGE_TOOL_LIMITS,
  KnowledgeToolName,
  projectKnowledgeToolResult,
} from "~/modules/knowledge/tool-schema.ts";
import { imageCallShape } from "~/modules/images/server/image-tool.ts";
import {
  IMAGE_TOOL,
  imageActivity,
  runningImageActivity,
  type ImageToolActivity,
} from "~/modules/images/tool-schema.ts";
import { type AssistantFileSource } from "../assistant-output.ts";
import { projectCustomToolResult } from "~/modules/custom-tools/tool-schema.ts";
import { projectIntegrationToolResult } from "~/modules/integrations/tool-schema.ts";
import { NotifyToolResult } from "~/modules/schedules/notify-schema.ts";
import { isBrowserTool, shownBrowserArgs } from "~/modules/browser/tool-schema.ts";
import { debugArguments, storedArguments } from "./stored-arguments.ts";

type ToolFamily = ToolChunkEnvelope["family"];
/**
 * What a call's row keeps of its arguments. Content in its own deletable row
 * (memory, drafts, documents) leaves nothing; tools that write content keep a
 * trimmed copy, since it lives in what they made; the rest keep what is shown.
 * Every family names one, so a new one cannot fall through to the wrong one.
 */
const STORED_ARGUMENTS = {
  memory: "none",
  "agent-draft": "none",
  "schedule-draft": "none",
  document: "none",
  skill: "trimmed",
  "project-file": "trimmed",
  "tool-file": "trimmed",
  presentation: "trimmed",
  spreadsheet: "trimmed",
  word: "trimmed",
  research: "trimmed",
  integration: "trimmed",
  image: "trimmed",
  ask: "ask",
  web: "shown",
  knowledge: "shown",
  desktop: "shown",
  plan: "shown",
  notify: "shown",
  map: "shown",
  attachment: "shown",
  "tool-load": "shown",
  custom: "shown",
} as const satisfies Record<ToolFamily, "none" | "trimmed" | "ask" | "shown">;

/** A memory save's or a plan's arguments live in their own rows and reminders, not in history. */
const redactOwnedArguments = (part: Response.AnyPart): Response.AnyPart =>
  part.type === "tool-call" && (part.name === "save_memory" || part.name === "update_plan")
    ? { ...part, params: {} }
    : part;
/** An updated plan is read from the trailing reminder, so its result only points there. */
const redactPlanResult = (part: Response.AnyPart): Response.AnyPart =>
  part.type === "tool-result" &&
  part.name === "update_plan" &&
  (part.result as PlanToolResult).outcome === "updated"
    ? {
        ...part,
        encodedResult: {
          outcome: "updated",
          message: "The current checklist is in the trailing reminder.",
        },
      }
    : part;
/**
 * What the next round's history keeps of a part: content with a home of its
 * own (memory, a plan, drafts, documents) travels there, never twice. Each step
 * leaves other tools' parts as they are.
 */
const forTheModel = (part: Response.AnyPart) =>
  [
    redactOwnedArguments,
    redactPlanResult,
    redactScheduleDraftPart,
    redactAgentDraftPart,
    redactDocumentPart,
  ].reduce((current, redact) => redact(current), part);

type StartEnvelope = Extract<ToolChunkEnvelope, { phase: "start" }>;
/** A start envelope without the fields every one of them shares. */
type StartFields = StartEnvelope extends infer E
  ? E extends unknown
    ? Omit<E, "v" | "phase" | "callId" | "turnIndex" | "callIndex" | "textOffset">
    : never
  : never;

/**
 * A family whose result is its projected activity, the handler's own reason
 * when it did not do its job, and a row marked by whether it did. One shape
 * for the row and the envelope, so the four such families settle the same way.
 */
const settledBy =
  <N extends string, A extends object>(family: {
    isName: (name: unknown) => name is N;
    project: (raw: unknown) => A;
    reason: (raw: unknown) => string | undefined;
    ok: (activity: A) => boolean;
    /** The row's error code when it did not do its job. */
    code: string;
    /** The reason for a call whose part failed: its output is the driver's, not the handler's. */
    failed: string;
    envelope: (input: {
      callId: string;
      name: N;
      activity: A;
      reason: string | undefined;
    }) => ToolChunkEnvelope;
  }) =>
  (part: { name: string; result: unknown; isFailure: boolean }, callId: string) => {
    if (!family.isName(part.name)) return null;
    const activity = family.project(part.isFailure ? null : part.result);
    const reason = part.isFailure ? family.failed : family.reason(part.result);
    return {
      result: activity,
      ok: family.ok(activity),
      error: reason ? { code: family.code, message: reason } : null,
      envelope: family.envelope({ callId, name: part.name, activity, reason }),
    };
  };

const SETTLED_FAMILIES = [
  settledBy<AgentDraftToolName, ReturnType<typeof projectAgentDraftResult>>({
    isName: Schema.is(AgentDraftToolName),
    project: projectAgentDraftResult,
    reason: agentDraftFailureReason,
    ok: agentDraftResultOk,
    code: "AgentDraftNotUpdated",
    failed: "The draft tool failed before it could respond.",
    envelope: ({ callId, name, activity, reason }) => ({
      v: 1,
      family: "agent-draft",
      phase: "result",
      callId,
      name,
      ...activity,
      ...(reason ? { reason } : {}),
    }),
  }),
  settledBy<ScheduleDraftToolName, ReturnType<typeof projectScheduleDraftResult>>({
    isName: Schema.is(ScheduleDraftToolName),
    project: projectScheduleDraftResult,
    reason: scheduleDraftFailureReason,
    ok: scheduleDraftResultOk,
    code: "ScheduleDraftNotUpdated",
    failed: "The draft tool failed before it could respond.",
    envelope: ({ callId, name, activity, reason }) => ({
      v: 1,
      family: "schedule-draft",
      phase: "result",
      callId,
      name,
      ...activity,
      ...(reason ? { reason } : {}),
    }),
  }),
  settledBy<DocumentToolName, ReturnType<typeof projectDocumentResult>>({
    isName: Schema.is(DocumentToolName),
    project: projectDocumentResult,
    reason: documentFailureReason,
    ok: documentResultOk,
    code: "DocumentNotUpdated",
    failed: "The document tool failed before it could respond.",
    envelope: ({ callId, name, activity, reason }) => ({
      v: 1,
      family: "document",
      phase: "result",
      callId,
      name,
      ...activity,
      ...(reason ? { reason } : {}),
    }),
  }),
  // File text the model read stays in this answer's rounds; the row keeps which file and version.
  settledBy<ProjectFileToolName, ReturnType<typeof projectProjectFileResult>>({
    isName: Schema.is(ProjectFileToolName),
    project: projectProjectFileResult,
    reason: projectFileFailureReason,
    ok: projectFileResultOk,
    code: "ProjectFileNotUsed",
    failed: "The project file tool failed before it could respond.",
    envelope: ({ callId, name, activity, reason }) => ({
      v: 1,
      family: "project-file",
      phase: "result",
      callId,
      name,
      ...activity,
      ...(reason ? { reason } : {}),
    }),
  }),
];
import { sourceTarget, mergeSource } from "~/modules/tools/sources.ts";
import type { Source, ToolChunkEnvelope, WebToolResult } from "~/modules/tools/schema.ts";
import {
  DesktopToolName,
  DesktopToolResult,
  forTranscript,
} from "~/modules/desktop/tool-schema.ts";
import type { SteerChunkEnvelope } from "../schema.ts";
import {
  calibrationFactor,
  compileActivePrompt,
  computeBudget,
  estimatePromptTokens,
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
  resumedRounds,
  type PromptDeps,
} from "./prompt.ts";
import { buildFixedPrefix } from "./system-prompt.ts";
import { attachmentReadActivity } from "./attachment-reader.ts";
import { isAdvertised } from "~/modules/tools/server/tool-load.ts";
import { LazyToolFamily, LoadToolsResult } from "~/modules/tools/tool-load-schema.ts";

import { buildSearchReminder, MAX_PRIOR_SOURCES, systemReminderMessage } from "./search-prompt.ts";
import type { JsonValue } from "~/db/schema/providers.ts";
import type { PreviewEvent, StatusEvent, StreamEvent } from "./generation/events.ts";
import { makeAttemptUsage, makeGenerationSink, shortErrorMessage } from "./generation/sink.ts";
import { loadAttemptContext, type GenerationInput } from "./generation/attempt-context.ts";
import { generationDeps } from "./generation/deps.ts";
import { prepareGenerationTools, quotedName } from "./generation/tools.ts";

export type {
  ChunkEvent,
  DoneEvent,
  LookupsEvent,
  PreviewEvent,
  StatusEvent,
  StreamEvent,
} from "./generation/events.ts";

/** How often a live tail checks whether its answer settled without it hearing. */
export const SettledCheckInterval = Context.Reference<Duration.Duration>(
  "chat/SettledCheckInterval",
  { defaultValue: () => Duration.seconds(15) },
);

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

// A block's first line names it ("Application-provided documents…"),
// so an updated block is matched to its earlier snapshot by that line.
const headerOf = (message: Prompt.MessageEncoded) => {
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  return (
    text
      .split("\n")
      .find((line) => line.trim())
      ?.slice(0, 160) ?? ""
  );
};

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
      openDocument?: OpenDocument | undefined;
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
     * produced. One whose row exists but whose fiber has not registered yet
     * stops as it registers. False when this instance is not running it now,
     * the same single-instance constraint the live chunk tail has (replay is
     * durable, the in-flight fiber is not).
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
      const deps = yield* generationDeps;
      const {
        repo,
        external,
        gateway,
        sync,
        providers,
        analytics,
        knowledgeService,
        customToolRepo,
        presentationFonts,
        policy,
        integrations,
        attachments,
        imageAttachments,
        keptFiles,
        basePromptDeps,
      } = deps;
      // The latest status of each generation still reading, for a subscriber that joins mid-read.
      const statuses = new Map<string, StatusEvent>();
      // The newest preview of each running image call, by message, so a page
      // that subscribes mid-draw (a reload, a second tab) sees it at once.
      const previews = new Map<string, Map<string, PreviewEvent>>();
      // Sliding, not unbounded: a subscriber that stops reading (stalled SSE
      // connection) must not buffer every in-flight generation's chunks
      // forever. Dropped events are recoverable: resume replays from
      // Postgres by seq, and `done` re-syncs the final row.
      const pubsub = yield* PubSub.sliding<StreamEvent>(4096);

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
      // messageId -> a stop that came before its generation registered (the
      // row commits a few steps before the fiber). The fiber claims it and
      // stops at once. Kept here, not on the chat, so an Undo cannot clear it;
      // an unclaimed one is pruned after a minute.
      const earlyStops = new Map<string, { runId: string; at: number }>();
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

      const runGeneration = Effect.fn("StreamEngine.runGeneration")(function* (
        input: GenerationInput & { abort: Deferred.Deferred<void> },
      ) {
        const ctx = yield* loadAttemptContext(
          { repo, policy, customToolRepo, integrations, providers },
          input,
        );
        if (!ctx) return;
        const {
          fence,
          config,
          permissions,
          selectedFeatureUnavailable,
          integrationOffer,
          runtimeContext,
          model,
          uiStateContext,
          resuming,
          ownCalls,
          ownSteers,
          ownFiles,
          firstTurn,
          roundLimit,
          steersByAnswer,
          completed,
          priorToolCalls,
          priorSources,
          priorUsage,
          earlierUsage,
          imageOutput,
        } = ctx;
        let replay = ctx.replay;
        const usage = makeAttemptUsage();
        const sink = yield* makeGenerationSink({
          repo,
          sync,
          pubsub,
          statuses,
          previews,
          fence,
          userId: input.userId,
          conversationId: input.conversationId,
          messageId: input.messageId,
          modelId: input.modelId,
          model,
          imageOutput,
          usage,
          earlierUsage,
          start: ctx.start,
        });
        // Scanned pages this answer needs are read in the sender's queue,
        // billed to them, and reported live while the answer waits.
        const promptDeps: PromptDeps = {
          ...basePromptDeps,
          parser: {
            availability: basePromptDeps.parser.availability,
            parsePdf: (pdf) =>
              basePromptDeps.parser.parsePdf({
                owner: input.userId,
                onScanProgress: (read, total) =>
                  sink.publishStatus(read < total ? { read, total } : null),
                ...pdf,
              }),
          },
        };

        const generate = Effect.gen(function* () {
          if (selectedFeatureUnavailable)
            return yield* Effect.fail(new Error("A selected feature is no longer available"));
          const tools = yield* prepareGenerationTools(deps, input, ctx, sink, promptDeps);
          const {
            authoring,
            scheduleAuthoring,
            documents,
            authority,
            indexer,
            webTools,
            interactiveUi,
            imageResolver,
            mapResolver,
            knowledgeSession,
            skillManifest,
            skillTools,
            callRowReady,
            desktopTools,
            browserTools,
            planTools,
            notifyTools,
            mapRouteTools,
            officeEditors,
            kept,
            keepChanges,
            workingFiles,
            toolFiles,
            officeFamilyOf,
            customTools,
            imageModel,
            imageBudget,
            imageTool,
            imageNotice,
            fileDelivery,
            publishFileTool,
            createFileTool,
            keptNotice,
            customToolNames,
            customToolOwners,
            customToolDisplayName,
            integrationTools,
            knowledgeTools,
            temporary,
            conversationContext,
            memoryTools,
            memorySpent,
            researchTool,
            conversationFiles,
            readable,
            offerState,
            offeredLazy,
            unlockedFamilies,
            unlockTool,
            unlockByCall,
            budgetToolkit,
            schemaTokensWith,
            toolSchemaTokens,
            summaryToolChoice,
          } = tools;
          let knowledgeContext: PreparedKnowledgeContext | null = null;
          let contextRowWritten = false;

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
          // Answers that expand into several prompt messages are built one by
          // one below; their attachments and tool rows are read once here
          // instead of twice per answer per pass.
          const expandable = historySuffix.filter(
            (message) =>
              message.assistantOutput?.files.length ||
              message.providerReplay?.turns.length ||
              steersByAnswer.has(message.id),
          );
          const expandedRows = yield* promptDeps.attachments.listWithBlobsForMessages([
            ...expandable.map((message) => message.id),
            ...expandable.flatMap((message) =>
              (steersByAnswer.get(message.id) ?? []).map((steer) => steer.id),
            ),
          ]);
          const callsByMessage = Map.groupBy(priorToolCalls, (call) => call.messageId);
          const expandedDeps: PromptDeps = {
            ...promptDeps,
            attachments: {
              ...promptDeps.attachments,
              listWithBlobsForMessages: (ids) =>
                Effect.succeed(expandedRows.filter((row) => ids.includes(row.messageId))),
            },
            chat: {
              listToolCalls: (ids) =>
                Effect.succeed(ids.flatMap((id) => callsByMessage.get(id) ?? [])),
            },
          };
          // What the previous request advertised: families its retained history
          // (everything after the last checkpoint) had loaded. The summary
          // repeats that list so it reads the cached prefix; the budget above
          // keeps the wider set as an upper bound.
          const priorUnlocked = new Set<LazyToolFamily>();
          if (offeredLazy.length) {
            const suffixIds = new Set(historySuffix.map((message) => message.id));
            for (const call of priorToolCalls)
              if (
                call.researchRunId === null &&
                (suffixIds.has(call.messageId) || call.messageId === input.messageId)
              )
                unlockByCall(priorUnlocked, call);
            for (const file of kept) if (isOfficeFamily(file.owner)) priorUnlocked.add(file.owner);
            for (const file of yield* promptDeps.attachments.listWithBlobsForMessages([
              ...suffixIds,
            ])) {
              const family = officeFamilyOfFile({ name: file.fileName, mediaType: file.mediaType });
              if (family) priorUnlocked.add(family);
            }
          }
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
            modelSupportsVision: model?.capabilities.vision ?? false,
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
                ? yield* buildHistoryMessages(expandedDeps, {
                    messages: [message],
                    steers: steersByAnswer,
                    deferAssistantBytes: true,
                    expandAssistantTurns: true,
                    modelSupportsFiles: model?.capabilities.files ?? false,
                    modelSupportsVision: model?.capabilities.vision ?? false,
                    inlineTextChars: inlineTextCharsFor(model?.contextLength),
                    ...(model
                      ? {
                          modelIdentity: {
                            providerId: model.providerId,
                            modelKey: model.modelKey,
                          },
                        }
                      : {}),
                  })
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
            knowledgeTools && offerState.retrievalEnabled
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
          // A reply in a schedule's chat sees earlier runs' notify_user calls
          // but not the tool, and read its absence as never having had it.
          const notifiedBefore =
            !notifyTools && priorToolCalls.some((call) => call.toolName === "notify_user");
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
              notifiedBefore
                ? "Earlier answers here that called notify_user were scheduled runs, and those notifications were sent. Only a run can notify; this reply is not one, so you cannot notify now. The next run can."
                : null,
              skillTools && skillTools.remaining() < SKILL_LIMITS.operations
                ? `Skill operations remaining: ${skillTools.remaining()} of ${SKILL_LIMITS.operations}.`
                : null,
              planReminder(),
            ].filter(Boolean);
            const updates = contextUpdates();
            // Context data rides as assistant messages (documents), and a request
            // that ends on one is a prefill, which some models refuse outright.
            if (sections.length === 0 && updates.at(-1)?.role === "assistant")
              sections.push("The application data above is current. Continue the answer.");
            const messages = [
              ...updates,
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
            ...imageNotice,
            ...(uiStateContext ? [uiStateContext] : []),
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
            const now = trailingContext();
            // oxlint-disable-next-line unicorn/consistent-function-scoping -- key is a one-line comparison read where it is used
            const key = (message: Prompt.MessageEncoded) => JSON.stringify(message.content);
            const before = new Set(answerContext.map(key));
            const headers = new Set(now.map(headerOf));
            // A block that vanished (a cleared draft, a removed document) says
            // so; its snapshot ahead of the rounds would otherwise still read as current.
            const gone = answerContext
              .map(headerOf)
              .filter((header) => header && !headers.has(header));
            return [
              ...now.filter((message) => !before.has(key(message))),
              ...(gone.length
                ? [
                    {
                      role: "user" as const,
                      content: `<context-update>\nNo longer current; the earlier snapshot of each no longer applies:\n${gone.map((header) => `- ${header}`).join("\n")}\n</context-update>`,
                    },
                  ]
                : []),
            ];
          };
          // Reminders are appended per request rather than stored in the
          // transcript, so only the budget adds them to the tail.
          const historyBudgetTail = (lastCycle: boolean): ReadonlyArray<Prompt.MessageEncoded> => [
            ...(answerContext ?? trailingContext()),
            ...((reminderPrompt(lastCycle)?.content ?? []) as ReadonlyArray<Prompt.MessageEncoded>),
          ];

          const deckFonts =
            officeEditors.includes("presentation") && Option.isSome(presentationFonts)
              ? [...new Set((yield* presentationFonts.value.list()).map((font) => font.family))]
              : [];
          // Tool policies, memory and instructions, then history, are the stable
          // prefix. Memory records are system role but tagged and quoted as
          // user-provided data, never instructions (docs/internals/memory.md).
          const fixedPrefix = buildFixedPrefix({
            lazyFamilies: offeredLazy,
            images: imageTool !== undefined,
            agentAuthoring: permissions.agentsCreate,
            documents: permissions.documents,
            knowledge: !!knowledgeSession,
            web: webTools ? webTools.tools : null,
            integrations: integrationTools
              ? [
                  ...new Set(
                    [...integrationTools.names.values()].map(
                      (entry) =>
                        integrationOffer.find(
                          (offer) => offer.integrationId === entry.integrationId,
                        )?.session.integration.name ?? entry.integrationId,
                    ),
                  ),
                ]
              : null,
            research: !!researchTool,
            desktop: desktopTools
              ? { folders: input.desktopFolders ?? [], commands: config.desktopCommands ?? false }
              : null,
            browser: !!browserTools,
            interactiveUi: skillManifest.some((entry) => entry.skillId === INTERACTIVE_UI_SKILL_ID)
              ? { photos: interactiveUi.images && !!webTools?.tools.search }
              : null,
            memory: conversationContext.messages(),
            project: config.resolvedProject ?? null,
            agent: config.resolvedAgent ?? null,
            ...(deckFonts.length ? { deckFonts } : {}),
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
              textOffset: sink.text().length,
              beforeTurnIndex: firstTurn,
              maxStartIndex,
              messages: historySuffix,
              renderedMessages: historyMessages,
              renderedMessageGroups: historyGroups,
              fixedPrefix,
              trailingMessages: historyBudgetTail(false),
              webToolsEnabled: webTools !== undefined,
              priorUsage,
              onCompaction: (event) => sink.pushCompaction({ v: 1, ...event }),
              // The tools and settings the first request will most likely send,
              // so a summary over this prompt reads it from the provider cache.
              ...(budgetToolkit
                ? {
                    summaryRequest: {
                      toolkit: budgetToolkit,
                      toolChoice: summaryToolChoice(budgetToolkit, priorUnlocked),
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
          yield* tools.unlockRetained(
            new Set(historySuffix.slice(compaction.startIndex).map((m) => m.id)),
          );

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
            offerState.retrievalEnabled = prepared.mode === "retrieval";
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
              const position = {
                turnIndex: firstTurn,
                callIndex: 0,
                textOffset: sink.text().length,
              };
              yield* repo.insertToolCall({
                id: rowId,
                messageId: input.messageId,
                ...position,
                providerCallId: `knowledge-context:${rowId}`,
                toolName: "knowledge_context",
                arguments: {},
              });
              yield* sink.pushTool({
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
              yield* sink.pushTool({
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
            .filter((skill) => skill.explicit)
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
              textOffset: sink.text().length,
              providerCallId: `skill-context:${rowId}`,
              toolName: "load_skill",
              arguments: {},
            });
            yield* sink.pushTool({
              v: 1,
              family: "skill",
              phase: "start",
              callId: rowId,
              name: "load_skill",
              turnIndex: firstTurn,
              callIndex: -5 + index,
              textOffset: sink.text().length,
              skillId: entry.skillId,
              skillName: entry.name,
              path: "SKILL.md",
            });
            yield* repo.completeToolCall({ id: rowId, result: activity, status: "complete" });
            yield* sink.pushTool({ v: 1, phase: "result", callId: rowId, ...activity });
          }
          const { nonMemoryToolkit, toolkit } = yield* tools.executionToolkits;

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
                ? yield* buildHistoryMessages(expandedDeps, {
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
                  })
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
            content: sink.text(),
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
          usage.estimatedFirstInputTokens = estimateRequestPrompt(false);
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
                textOffset: sink.text().length,
                scope: "history" as const,
              };
              yield* repo.createCompactionEvent({
                id: eventId,
                messageId: input.messageId,
                ...position,
              });
              yield* sink.pushCompaction({ v: 1, phase: "start", eventId, ...position });
              yield* repo.completeCompactionEvent({
                id: eventId,
                status: "complete",
                outcome: "hard_truncation",
              });
              yield* sink.pushCompaction({
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
              usage.firstInputTokens !== undefined && usage.estimatedFirstInputTokens !== undefined
                ? calibrationFactor({
                    firstInputTokens: usage.firstInputTokens,
                    estimatedFirstInputTokens: usage.estimatedFirstInputTokens,
                  })
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
                  textOffset: sink.text().length,
                  passIndex: nextPassIndex(turn),
                  calibrationFactor: factor,
                  sourceManifest: sourceManifest(),
                  ...(trailing ? { trailingPrompt: trailing } : {}),
                  onCompaction: (event) => sink.pushCompaction({ v: 1, ...event }),
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
            if (round === 0) usage.estimatedFirstInputTokens = estimateRequestPrompt(false);
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
            tools.setPreviewTarget(turnFiles);
            const turnStartOffset = sink.text().length;
            // One fenced registration for every file an answer delivers (a
            // publish, a custom tool's output, a shared screenshot): the
            // attachment and its file chunk land together, under the fence.
            const deliverFile = (
              file: {
                name: string;
                mediaType: string;
                bytes: Uint8Array;
                fileSource?: AssistantFileSource;
                reserved?: boolean;
              },
              toolCallId: string,
              inTransaction?: (
                tx: DbTx,
                owner: GenerationIdentity,
              ) => Effect.Effect<ReadonlyArray<string>>,
            ) =>
              Effect.gen(function* () {
                if (!fence || Option.isNone(imageAttachments))
                  return { reason: "File delivery is unavailable." } as const;
                yield* sink.flush;
                const accepted = yield* sink
                  .fileChunk(
                    (at) =>
                      acceptGeneratedFile(imageAttachments.value, {
                        fence,
                        fileName: file.name,
                        mediaType: file.mediaType,
                        bytes: file.bytes,
                        origin: { toolCallId },
                        source: file.fileSource ?? "tool",
                        ...(file.reserved ? { reserved: true } : {}),
                        ...(inTransaction
                          ? { inTransaction: (tx: DbTx) => inTransaction(tx, fence) }
                          : {}),
                        textOffset: at.textOffset,
                        turnIndex: turn,
                        callIndex,
                        eventIndex: at.seq,
                        seq: at.seq,
                      }),
                    { countsAsDelivered: true },
                  )
                  .pipe(Effect.result);
                return accepted._tag === "Success"
                  ? ({ attachment: accepted.success.attachment } as const)
                  : ({ reason: accepted.failure.reason } as const);
              });
            // provider call id -> our durable row id
            const callRowIds = new Map<string, string>();
            // What an image call draws, named at its start and kept for its result.
            const imageCalls = new Map<string, ImageToolActivity>();
            // Where each call was made in the answer's text, for envelopes sent after it.
            const callTextOffsets = new Map<string, number>();
            // The argument summary an integration row showed at start, for its result.
            const integrationSummaries = new Map<string, string | null>();
            // Snapshots asked to show their screenshot to the user, by provider call id.
            const sharedSnapshots = new Set<string>();
            tools.clearCallRows();
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
                ? Object.keys(activeToolkit.tools).filter(
                    (name) =>
                      isAdvertised(name, offeredLazy, unlockedFamilies) &&
                      (offerState.readerAdvertised || name !== "read_attachment"),
                  )
                : [];
              usage.modelCallOpen = true;
              const prompt = requestPrompt();
              // Only what this request carries counts as what the model saw of a document.
              documents.sent(prompt);
              return gateway
                .streamChat({
                  imageOutput,
                  modelId: input.modelId,
                  reasoningEffort: config.reasoningEffort,
                  cacheKey: input.conversationId,
                  // Rebuilt every round and always last: the recap has to sit
                  // behind the tool results it competes with. It is budgeted but
                  // never fed back into the continuation transcript.
                  prompt,
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
                        turnParts.push(forTheModel(part));
                      }
                      switch (part.type) {
                        case "file": {
                          if (!imageOutput || !fence || Option.isNone(imageAttachments))
                            return yield* Effect.die(
                              new Error("Image output is unavailable for this call."),
                            );
                          yield* sink.flush;
                          const image = yield* sink.fileChunk(
                            (at) =>
                              acceptGeneratedImage(imageAttachments.value, {
                                fence,
                                mediaType: part.mediaType,
                                data: part.data,
                                textOffset: at.textOffset,
                                turnIndex: turn,
                                callIndex,
                                eventIndex: at.seq,
                                seq: at.seq,
                              }),
                            { countsAsDelivered: false },
                          );
                          turnFiles.push({
                            type: "text",
                            text: attachmentReferenceHint(image.attachment),
                          });
                          // Held for good, so a later tool call does not draw what cannot be kept.
                          imageBudget.reserve(1);
                          sink.countDeliveredFile();
                          return;
                        }
                        case "text-delta": {
                          sink.push("text", part.delta);
                          // Only a fence line can close a block.
                          if (/[`~]/.test(part.delta)) {
                            if (imageResolver) yield* imageResolver.observe(sink.text());
                            if (mapResolver) yield* mapResolver.observe(sink.text());
                          }
                          if (sink.buffered() >= 16) yield* sink.flush;
                          return;
                        }
                        case "reasoning-delta": {
                          // The adapter writes encrypted reasoning as the text
                          // "[REDACTED]"; the encrypted part still rides the
                          // replay, so the reader gets the bare thinking marker.
                          sink.push("reasoning", part.delta === "[REDACTED]" ? "" : part.delta);
                          if (sink.buffered() >= 16) yield* sink.flush;
                          return;
                        }
                        case "reasoning-start": {
                          // Hidden-reasoning marker: an empty reasoning chunk lets
                          // the UI show "Thinking…" even if no readable trace follows.
                          sink.push("reasoning", "");
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
                          const family = tools.familyOf(part.name);
                          if (!family) return;
                          const rowId = uuidv7();
                          callRowIds.set(part.id, rowId);
                          const askArgs =
                            family === "ask"
                              ? Schema.decodeUnknownOption(AskUserParams)(args)
                              : null;
                          const textOffset = sink.text().length;
                          callTextOffsets.set(part.id, textOffset);
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
                            // A page loading mid-draw shows the model and frame the live start names.
                            ...(family === "image" && imageModel
                              ? {
                                  result: json(
                                    runningImageActivity(imageCallShape(imageModel, args)),
                                  ),
                                }
                              : {}),
                            arguments:
                              STORED_ARGUMENTS[family] === "none"
                                ? {}
                                : STORED_ARGUMENTS[family] === "trimmed"
                                  ? storedArguments(args)
                                  : STORED_ARGUMENTS[family] === "ask"
                                    ? askArgs && Option.isSome(askArgs)
                                      ? json(askArgs.value)
                                      : {}
                                    : (shownArgs as JsonValue),
                          });
                          // Typed browser text may be a password; owned content has its own row.
                          if (STORED_ARGUMENTS[family] !== "none")
                            sink.keepDebugArguments(rowId, debugArguments(shownArgs));
                          const start = (fields: StartFields) =>
                            sink.pushTool({
                              v: 1,
                              phase: "start",
                              callId: rowId,
                              turnIndex: turn,
                              callIndex: callIndex - 1,
                              textOffset,
                              ...fields,
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
                              textOffset,
                            });
                            return;
                          }
                          const office = officeFamilyOf(part.name);
                          if (office) {
                            yield* start({ family: office.family, name: part.name });
                            return;
                          }
                          if (family === "tool-file") {
                            yield* start({
                              family: "tool-file",
                              name: part.name === "create_file" ? "create_file" : "publish_file",
                            });
                            return;
                          }
                          if (family === "attachment") {
                            yield* start({ family, name: "read_attachment" });
                            return;
                          }
                          if (family === "tool-load") {
                            yield* start({ family, name: "load_tools" });
                            return;
                          }
                          if (
                            family === "memory" ||
                            family === "ask" ||
                            family === "plan" ||
                            family === "notify" ||
                            family === "map"
                          ) {
                            yield* start(
                              family === "plan"
                                ? { family, name: "update_plan" }
                                : { family, name: part.name },
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
                              timeoutMs: desktopToolTimeout(part.name as DesktopToolName),
                            });
                            yield* Deferred.succeed(ready, {
                              rowId,
                              turnIndex: turn,
                              callIndex: callIndex - 1,
                            });
                            yield* start({
                              family,
                              name: part.name as DesktopToolName,
                              args: shownArgs,
                            });
                            return;
                          }
                          if (family === "agent-draft") {
                            yield* start({ family, name: part.name as AgentDraftToolName });
                            return;
                          }
                          if (family === "schedule-draft") {
                            yield* start({ family, name: part.name as ScheduleDraftToolName });
                            return;
                          }
                          if (family === "document") {
                            yield* start({ family, name: part.name as DocumentToolName });
                            return;
                          }
                          if (family === "project-file") {
                            yield* start({ family, name: part.name as ProjectFileToolName });
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
                            yield* start({
                              family,
                              name: part.name,
                              integrationId: entry.integrationId,
                              tool: entry.tool.name,
                              label: entry.tool.label,
                              access: entry.tool.access,
                              summary,
                            });
                            return;
                          }
                          if (family === "image") {
                            if (!imageModel) return;
                            const shape = runningImageActivity(imageCallShape(imageModel, args));
                            imageCalls.set(part.id, shape);
                            // Previews name the call by this row, which the handler cannot know.
                            yield* Deferred.succeed(callRowReady(part.id), {
                              rowId,
                              turnIndex: turn,
                              callIndex: callIndex - 1,
                              textOffset,
                            });
                            yield* start({
                              family: "image",
                              name: IMAGE_TOOL,
                              model: shape.model,
                              editing: shape.editing,
                              ...(shape.aspectRatio ? { aspectRatio: shape.aspectRatio } : {}),
                              count: shape.requested,
                            });
                            return;
                          }
                          if (family === "custom") {
                            yield* start({
                              family,
                              name: part.name,
                              displayName: customToolDisplayName(part.name),
                            });
                            return;
                          }
                          if (family === "skill") {
                            const entry = config.skills?.find(
                              (skill) => skill.skillId === args["skillId"],
                            );
                            yield* start({
                              family: "skill",
                              name: part.name as typeof SkillToolName.Type,
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
                            yield* start({
                              family,
                              name: part.name as typeof KnowledgeToolName.Type,
                              ...(queries.length > 0 ? { targets: queries } : {}),
                            });
                            return;
                          }

                          const targets = Array.isArray(args["queries"])
                            ? args["queries"].map(String)
                            : Array.isArray(args["urls"])
                              ? args["urls"].map(String)
                              : [];
                          yield* start({ family, name: part.name, args: { targets } });
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
                            const failure = ok
                              ? undefined
                              : (result.message ?? "Research produced no evidence.");
                            // The run wrote this row's body as it went. Settling
                            // the call must not replace the progress and sources
                            // the panel reads back on reload.
                            yield* repo.settleToolCall({
                              id: rowId,
                              status: ok ? "complete" : "error",
                              ...(failure
                                ? { error: { code: "ResearchIncomplete", message: failure } }
                                : {}),
                            });
                            if (run)
                              yield* sink.pushTool({
                                v: 1,
                                family: "research",
                                phase: "result",
                                callId: rowId,
                                runId: run.id,
                                name: "deep_research",
                                turnIndex: turn,
                                callIndex: callIndex - 1,
                                textOffset: callTextOffsets.get(part.id) ?? 0,
                                progress: run.progress,
                                ok,
                                ...(failure ? { error: failure } : {}),
                              });
                            return;
                          }
                          for (const settle of SETTLED_FAMILIES) {
                            const outcome = settle(part, rowId);
                            if (!outcome) continue;
                            if (isPreliminary) return;
                            yield* repo.completeToolCall({
                              id: rowId,
                              result: json(outcome.result),
                              status: outcome.ok ? "complete" : "error",
                              ...(outcome.error ? { error: outcome.error } : {}),
                            });
                            yield* sink.pushTool(outcome.envelope);
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
                                : unusableDesktopResult(part.isFailure ? part.result : null);
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
                            yield* sink.pushTool({
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
                            yield* sink.pushTool({
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
                            yield* sink.pushTool({
                              v: 1,
                              family: office.family,
                              phase: "result",
                              callId: rowId,
                              name: part.name,
                              ...activity,
                            } as ToolChunkEnvelope);
                            return;
                          }
                          if (
                            (part.name === "publish_file" && publishFileTool) ||
                            (part.name === "create_file" && createFileTool)
                          ) {
                            if (isPreliminary) return;
                            const pending = fileDelivery.take(part.id);
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
                            yield* sink.pushTool({
                              v: 1,
                              family: "tool-file",
                              phase: "result",
                              callId: rowId,
                              name: part.name === "create_file" ? "create_file" : "publish_file",
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
                            yield* sink.pushTool({
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
                            yield* sink.pushTool({
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
                            yield* sink.pushTool({
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
                          if (part.name === "notify_user" && notifyTools) {
                            if (isPreliminary) return;
                            const decoded = Schema.decodeUnknownOption(NotifyToolResult)(
                              part.result,
                            );
                            const result: NotifyToolResult =
                              !part.isFailure && Option.isSome(decoded)
                                ? decoded.value
                                : { v: 1, outcome: "rejected", message: "Nothing was sent." };
                            const ok = result.outcome === "queued";
                            yield* repo.completeToolCall({
                              id: rowId,
                              result: json(result),
                              status: ok ? "complete" : "error",
                              ...(ok
                                ? {}
                                : { error: { code: "NotifyRejected", message: result.message } }),
                            });
                            yield* sink.pushTool({
                              v: 1,
                              family: "notify",
                              phase: "result",
                              callId: rowId,
                              name: "notify_user",
                              ok,
                              ...(ok ? { message: result.message } : { error: result.message }),
                            });
                            return;
                          }
                          if (part.name === MAP_ROUTE_TOOL && mapRouteTools) {
                            if (isPreliminary) return;
                            const decoded = Schema.decodeUnknownOption(MapRouteResult)(part.result);
                            const result: MapRouteResult =
                              !part.isFailure && Option.isSome(decoded)
                                ? decoded.value
                                : { v: 1, outcome: "rejected", message: "No route was found." };
                            const summary = summarizeMapRoute(result);
                            const ok = summary !== null;
                            yield* repo.completeToolCall({
                              id: rowId,
                              result: json(result),
                              status: ok ? "complete" : "error",
                              ...(result.outcome === "rejected"
                                ? { error: { code: "RouteNotFound", message: result.message } }
                                : {}),
                            });
                            yield* sink.pushTool({
                              v: 1,
                              family: "map",
                              phase: "result",
                              callId: rowId,
                              name: MAP_ROUTE_TOOL,
                              ok,
                              ...(summary
                                ? { route: summary }
                                : { error: result.outcome === "rejected" ? result.message : "" }),
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
                            yield* sink.pushTool({
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
                            yield* sink.pushTool({
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
                            yield* sink.pushTool({
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
                            const { sources, access, files, decided } = integrationTools!.take(
                              part.id,
                            );
                            // Files a service returned become attachments of the answer,
                            // stored under the fence like a custom tool's; a failed one is noted.
                            // By position: the result lists the files in the order returned,
                            // and two may share a name.
                            const undelivered = new Map<number, string>();
                            for (const [index, file] of files.entries()) {
                              const stored = yield* deliverFile(file, rowId);
                              if ("reason" in stored) {
                                undelivered.set(index, stored.reason.slice(0, 200));
                                continue;
                              }
                              turnFiles.push(
                                yield* fileForModel(promptDeps.parser, {
                                  id: stored.attachment.id,
                                  fileName: file.name,
                                  mediaType: stored.attachment.mediaType,
                                  bytes: file.bytes,
                                  vision: model?.capabilities.vision ?? false,
                                  files: model?.capabilities.files ?? false,
                                }),
                              );
                            }
                            // The result already names each file; mark the ones that did not arrive.
                            const returned = part.result as { ok?: unknown; result?: unknown };
                            const output = returned.result as
                              | { files?: unknown }
                              | null
                              | undefined;
                            if (
                              undelivered.size &&
                              returned.ok === true &&
                              output &&
                              Array.isArray(output.files)
                            ) {
                              const noted = {
                                ...returned,
                                result: {
                                  ...output,
                                  files: output.files.map((entry: object, index: number) =>
                                    undelivered.has(index)
                                      ? { ...entry, notAttached: undelivered.get(index) }
                                      : entry,
                                  ),
                                },
                              };
                              Object.assign(part, { result: noted, encodedResult: noted });
                            }
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
                              // A call that reached people is recorded as destructive.
                              access: access ?? integrationEntry.tool.access,
                              summary: integrationSummaries.get(part.id) ?? null,
                              raw: part.result,
                              isFailure: part.isFailure,
                              sources,
                              decided,
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
                            yield* sink.pushTool({
                              v: 1,
                              family: "integration",
                              phase: "result",
                              callId: rowId,
                              name: part.name,
                              activity,
                            });
                            return;
                          }

                          if (part.name === IMAGE_TOOL && imageTool && imageModel) {
                            if (isPreliminary) return;
                            const raw = (part.result ?? {}) as {
                              ok?: boolean;
                              quality?: ImageQuality;
                              adjustments?: ReadonlyArray<string>;
                              refusal?: string;
                              error?: string;
                            };
                            const shape =
                              imageCalls.get(part.id) ??
                              runningImageActivity(imageCallShape(imageModel, {}));
                            imageCalls.delete(part.id);
                            sink.clearPreview(rowId);
                            const staged = imageTool.take(part.id);
                            const attachmentIds: string[] = [];
                            const failures: string[] = [];
                            const images = staged?.images ?? [];
                            for (const [index, image] of images.entries()) {
                              const extension = image.mediaType.split("/")[1] ?? "png";
                              const stored = yield* deliverFile(
                                {
                                  // Numbered only when the call made several.
                                  name: `${staged?.stem ?? "image"}${images.length > 1 ? `-${index + 1}` : ""}.${extension === "jpeg" ? "jpg" : extension}`,
                                  mediaType: image.mediaType,
                                  bytes: image.data,
                                  fileSource: "image-tool",
                                  // Its slot was granted before it drew: kept even if the
                                  // model's own images filled the count since.
                                  reserved: true,
                                },
                                rowId,
                              );
                              if ("reason" in stored) {
                                failures.push(stored.reason);
                                continue;
                              }
                              attachmentIds.push(stored.attachment.id);
                              // Vision models see what they made, once, like any file.
                              turnFiles.push(
                                yield* fileForModel(promptDeps.parser, {
                                  id: stored.attachment.id,
                                  fileName: stored.attachment.fileName,
                                  mediaType: stored.attachment.mediaType,
                                  bytes: image.data,
                                  vision: model?.capabilities.vision ?? false,
                                  files: model?.capabilities.files ?? false,
                                }),
                              );
                            }
                            staged?.settle(attachmentIds.length);
                            // Some kept and some not: the call succeeded, but the paid-for
                            // images it lost are said, first, so the caption never drops it.
                            const adjustments =
                              attachmentIds.length > 0 && failures.length > 0
                                ? [
                                    `${failures.length} of ${failures.length + attachmentIds.length} images could not be kept: ${failures[0]}`,
                                    ...(raw.adjustments ?? []),
                                  ]
                                : raw.adjustments;
                            const error =
                              raw.error ??
                              (staged && attachmentIds.length === 0
                                ? (failures[0] ?? "The images could not be stored.")
                                : undefined);
                            if (staged) {
                              const delivered = {
                                ...raw,
                                ...(attachmentIds.length === 0 ? { ok: false } : {}),
                                ...(error ? { error } : {}),
                                ...(adjustments ? { adjustments } : {}),
                                images: attachmentIds.length,
                                attachmentIds,
                                files: attachmentIds.map((id) =>
                                  formatFileRef({ kind: "attachment", id }),
                                ),
                              };
                              Object.assign(part, { result: delivered, encodedResult: delivered });
                            }
                            const activity = imageActivity({
                              ...shape,
                              attachmentIds,
                              quality: raw.quality,
                              adjustments,
                              refusal: raw.refusal,
                              error: part.isFailure
                                ? "The image tool failed."
                                : raw.refusal
                                  ? undefined
                                  : error,
                            });
                            yield* repo.completeToolCall({
                              id: rowId,
                              result: json(activity),
                              status: activity.status,
                              ...(activity.status === "error"
                                ? {
                                    error: {
                                      code: activity.refusal ? "ImageRefused" : "ImageFailed",
                                      message:
                                        activity.refusal ?? activity.error ?? "No image was made.",
                                    },
                                  }
                                : {}),
                            });
                            yield* sink.pushTool({
                              v: 1,
                              phase: "result",
                              callId: rowId,
                              name: IMAGE_TOOL,
                              ...activity,
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
                            yield* sink.pushTool({
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
                            yield* sink.pushTool({
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
                          yield* sink.pushTool({
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
                          addFinishUsage(usage.totals, part);
                          usage.modelCallOpen = false;
                          if (imageOutput && providerCostOf(part.metadata) === null)
                            usage.imageCostIncomplete = true;
                          // The round's opaque reasoning state, kept with the
                          // answer so its history replays it to the same model.
                          const unit = replayUnitOf(replayOf(part.metadata));
                          if (model && (unit || imageOutput)) {
                            const next = appendReplay(replay, {
                              turnIndex: turn,
                              startOffset: turnStartOffset,
                              endOffset: sink.text().length,
                              unit,
                            });
                            if (next && next !== replay) {
                              replay = next;
                              yield* repo.saveProviderReplay(input.messageId, next);
                            }
                          }
                          if (!usage.sawFirstFinish) {
                            usage.sawFirstFinish = true;
                            usage.firstInputTokens = part.usage.inputTokens.total;
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
                          // An Office edit or a research brief is a call the model
                          // can spend a while writing; say so before it completes.
                          if (
                            officeFamilyOfEdit(part.name) ||
                            part.name === "deep_research" ||
                            isDocumentWrite(part.name)
                          ) {
                            sink.push(
                              "writing",
                              JSON.stringify({
                                v: 1,
                                id: part.id,
                                name: part.name,
                                textOffset: sink.text().length,
                                turnIndex: turn,
                                // A resumed answer replays this chunk; the attempt
                                // it names tells the client it is no longer writing.
                                ...(fence ? { runId: fence.generationId } : {}),
                              }),
                            );
                            yield* sink.flush;
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
                  // A stopped answer keeps what its previews wrote; any other end
                  // undoes the ones no call claimed.
                  Effect.onExit((exit) =>
                    Exit.hasInterrupts(exit) ? documents.live.abandon : documents.live.close,
                  ),
                );
            });

            const currentCalibration = () =>
              usage.firstInputTokens !== undefined && usage.estimatedFirstInputTokens !== undefined
                ? calibrationFactor({
                    firstInputTokens: usage.firstInputTokens,
                    estimatedFirstInputTokens: usage.estimatedFirstInputTokens,
                  })
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

                    const overflowFactor = currentCalibration();
                    const beforeEstimate = Math.ceil(
                      estimateRequestPrompt(!toolRoundsLeft) * overflowFactor,
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
                            textOffset: sink.text().length,
                            passIndex: nextPassIndex(turn),
                            calibrationFactor: overflowFactor,
                            sourceManifest: sourceManifest(),
                            ...(currentReminderPrompt()
                              ? { trailingPrompt: currentReminderPrompt()! }
                              : {}),
                            force: true,
                            onCompaction: (event) => sink.pushCompaction({ v: 1, ...event }),
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
                      calibrationFactor: overflowFactor,
                    });
                    if (!shrunk) return yield* Effect.fail(error);

                    compaction = { ...compaction, ...shrunk, mode: "truncated" };
                    syncEarlierSkills(compaction.startIndex);
                    transcript = buildTranscript();
                    if (round === 0) {
                      usage.estimatedFirstInputTokens = estimateRequestPrompt(!toolRoundsLeft);
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
            const { steered, held } =
              fence && round < roundLimit
                ? yield* repo.claimSteeredEntries({
                    conversationId: input.conversationId,
                    messageId: input.messageId,
                    textOffset: sink.text().length,
                    turnIndex: turn,
                  })
                : { steered: [], held: false };
            if (held)
              yield* sync.publish(input.userId, {
                type: "conversation.queue.changed",
                conversationId: input.conversationId,
              });
            // A completed response/tool batch is one atomic unit. It becomes
            // eligible for compaction only now, after every tool result is
            // terminal; no call can ever be separated from its result.
            // Files keep their place among the text, and the round's replay
            // unit rides on the assistant message.
            const roundMessages = roundPrompt(turnParts);
            activeRounds = [
              ...activeRounds,
              {
                turnIndex: turn,
                prompt:
                  turnFiles.length === 0
                    ? roundMessages
                    : Prompt.concat(
                        roundMessages,
                        Prompt.make([{ role: "user", content: turnFiles }]),
                      ),
              },
            ];
            if (steered.length > 0) {
              steeredAfter = round;
              // The latest steer's document and selection are what "this" now means.
              const focus = steered.findLast((message) => message.openDocument)?.openDocument;
              if (focus) documents.focus(focus.id, focus.selected, focus.thread);
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
              // Readable by id from the next round, like a file sent with the question.
              conversationFiles.push(...files);
              if (files.some(readable)) offerState.readerAdvertised = true;
              for (const message of steered) {
                const envelope: SteerChunkEnvelope = {
                  v: 1,
                  id: message.id,
                  queueEntryId: message.queueEntryId,
                  content: message.content,
                  textOffset: message.steerTextOffset ?? sink.text().length,
                  turnIndex: message.steerTurnIndex ?? turn,
                  attachments: files
                    .filter((file) => file.messageId === message.id)
                    .map(toAttachmentDto),
                };
                sink.push("steer", JSON.stringify(envelope));
              }
              yield* sink.flush;
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
          // Before the scope closes and finalize runs: recording needs the row still streaming.
          yield* Effect.all(
            [imageResolver?.drain ?? Effect.void, mapResolver?.drain ?? Effect.void],
            { concurrency: "unbounded", discard: true },
          );
          // Internal tool rounds need no prose. A validated question is itself the
          // answer; research returns through its own runner before this chat loop.
          // A resumed answer starts from its earlier text, so it is never empty.
          if (!questionPresented && sink.text().trim().length === 0 && sink.deliveredFiles() === 0)
            return yield* Effect.fail(new Error("[ResponseEmpty]"));
        });

        // Periodic flusher so slow generations still persist promptly.
        const flusher = sink.flush.pipe(Effect.delay(Duration.millis(250)), Effect.forever);

        // Stopping wins the race by *succeeding*, not by interrupting from the
        // outside: the model stream is interrupted but finalize still runs, so
        // the text produced so far is persisted and subscribers get a `done`.
        const stopped = Deferred.await(input.abort).pipe(Effect.as(true));
        const ran = generate.pipe(Effect.scoped, Effect.as(false));

        yield* Effect.raceFirst(Effect.raceFirst(ran, stopped), flusher).pipe(
          Effect.flatMap((wasStopped) => sink.finalize(wasStopped ? "aborted" : "complete")),
          Effect.catchCause((cause) => sink.finalize("error", cause)),
          Effect.onInterrupt(() => sink.finalize("error")),
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
        openDocument?: OpenDocument | undefined;
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
        // After registering: a stop from now on finds the registration, and
        // one from before it left an early stop to claim.
        const early = earlyStops.get(input.messageId);
        if (early?.runId === input.generationId) {
          earlyStops.delete(input.messageId);
          yield* Deferred.succeed(abort, undefined);
        }
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
                    modelId: input.modelId,
                    modelName: input.modelId,
                    conversationId: input.conversationId,
                    messageId: input.messageId,
                    status: "error",
                    inputTokens: 0,
                    outputTokens: 0,
                    cachedInputTokens: 0,
                    cacheWriteTokens: null,
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
                    if (inFlight.get(input.messageId) === registration) {
                      inFlight.delete(input.messageId);
                      statuses.delete(input.messageId);
                      previews.delete(input.messageId);
                    }
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
          if (!registration && expectedRunId) {
            const now = Date.now();
            for (const [id, stop] of earlyStops) if (now - stop.at > 60_000) earlyStops.delete(id);
            earlyStops.set(messageId, { runId: expectedRunId, at: now });
          }
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
            const settledEvery = yield* SettledCheckInterval;

            const replay: Stream.Stream<StreamEvent> = Stream.fromIterable(
              persisted.map((c) => ({
                kind: "chunk" as const,
                ...(runId ? { runId } : {}),
                messageId,
                seq: c.seq,
                chunkKind: c.kind,
                delta: c.delta,
                at: c.createdAt.getTime(),
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

            const status = statuses.get(messageId);
            const toChunk = (c: (typeof persisted)[number]): StreamEvent => ({
              kind: "chunk",
              ...(runId ? { runId } : {}),
              messageId,
              seq: c.seq,
              chunkKind: c.kind,
              delta: c.delta,
              at: c.createdAt.getTime(),
            });
            // The PubSub slides, so a slow reader can miss events. Chunks are
            // stored before they are published, so what it missed is read back.
            const missed = (before: number) =>
              repo
                .chunksAfter(messageId, lastSeq)
                .pipe(Effect.map((rows) => rows.filter((c) => c.seq < before).map(toChunk)));
            const inOrder = (event: StreamEvent): Stream.Stream<StreamEvent> =>
              event.kind === "chunk" && event.seq > lastSeq + 1
                ? Stream.unwrap(
                    Effect.map(missed(event.seq), (rows) => Stream.fromIterable([...rows, event])),
                  )
                : Stream.make(event);
            const live: Stream.Stream<StreamEvent> = Stream.fromSubscription(subscription).pipe(
              Stream.filter((event) => event.messageId === messageId && event.runId === runId),
              Stream.filter((event) => event.kind !== "chunk" || event.seq > lastSeq),
              Stream.flatMap(inOrder),
            );
            // A missed `done` would hold the request open, so the row is checked
            // now and then; once settled, the rest is read back and the stream ends.
            const settled: Stream.Stream<StreamEvent> = Stream.fromEffectSchedule(
              repo.getMessage(messageId).pipe(Effect.orDie),
              Schedule.spaced(settledEvery),
            ).pipe(
              Stream.filter(
                (row) => row?.status !== "streaming" || (row.generationId ?? undefined) !== runId,
              ),
              Stream.take(1),
              Stream.flatMap((row) =>
                Stream.unwrap(
                  Effect.map(missed(Number.POSITIVE_INFINITY), (rows) =>
                    Stream.fromIterable<StreamEvent>([
                      ...rows,
                      {
                        kind: "done",
                        messageId,
                        ...(runId ? { runId } : {}),
                        status:
                          row &&
                          (row.generationId ?? undefined) === runId &&
                          row.status !== "streaming"
                            ? row.status
                            : "error",
                      },
                    ]),
                  ),
                ),
              ),
            );
            const tail = Stream.merge(live, settled, { haltStrategy: "either" }).pipe(
              Stream.filter((event) => event.kind !== "chunk" || event.seq > lastSeq),
              Stream.tap((event) =>
                Effect.sync(() => {
                  if (event.kind === "chunk") lastSeq = event.seq;
                }),
              ),
              Stream.takeUntil((event) => event.kind === "done"),
            );

            const reading: Stream.Stream<StreamEvent> =
              status && status.runId === runId
                ? Stream.make({ kind: "status", ...status })
                : Stream.empty;
            // Read after subscribing, so an image recorded since the loader ran is in one or the other.
            const output = afterReplay.assistantOutput;
            const imageSnapshot: Stream.Stream<StreamEvent> =
              output?.images || output?.places || output?.routes
                ? Stream.make({
                    kind: "lookups",
                    messageId,
                    ...(runId ? { runId } : {}),
                    lookups: lookupsOf(output),
                  })
                : Stream.empty;
            const drawing: Stream.Stream<StreamEvent> = Stream.fromIterable(
              [...(previews.get(messageId)?.values() ?? [])]
                .filter((event) => event.runId === runId)
                .map((event) => ({ kind: "preview" as const, ...event })),
            );
            return replay.pipe(
              Stream.concat(reading),
              Stream.concat(imageSnapshot),
              Stream.concat(drawing),
              Stream.concat(tail),
            );
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
