import { redactDocumentPart } from "~/modules/documents/tool-schema.ts";
import { redactAgentDraftPart } from "~/modules/agents/tool-schema.ts";
import { redactScheduleDraftPart } from "~/modules/schedules/tool-schema.ts";
import { roundPrompt } from "@chat/model-client";
import { Effect, Exit, Stream, type Scope } from "effect";
import { PlanToolResult } from "~/modules/tools/plan-schema.ts";
import { Prompt, type Response } from "effect/unstable/ai";
import { toAttachmentDto } from "~/modules/attachments/server/repo.ts";
import { ProviderContextOverflow } from "~/modules/providers/server/gateway.ts";
import type { SteerChunkEnvelope } from "../../schema.ts";
import {
  calibrationFactor,
  compileActivePrompt,
  computeBudget,
  ContextTooLarge,
  prepareCompactedActiveRounds,
  shrinkForOverflow,
  summaryTokensFor,
  type ActiveRoundCompactionDecision,
} from "../compaction.ts";
import { buildHistoryMessages, inlineTextCharsFor, type PromptDeps } from "../prompt.ts";
import { isAdvertised } from "~/modules/tools/server/tool-load.ts";
import { promptMessages } from "./json.ts";
import type { AttemptContext, GenerationInput } from "./attempt-context.ts";
import type { AttemptPrompt } from "./attempt-prompt.ts";
import type { GenerationDeps } from "./deps.ts";
import type { AttemptUsage, GenerationSink } from "./sink.ts";
import type { GenerationTools } from "./tools.ts";
import { observePart, type TurnState } from "./observe.ts";

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

/** Everything one round reads: the attempt, its sink, tools and prompt. */
export interface RoundEnv {
  deps: GenerationDeps;
  input: GenerationInput;
  ctx: AttemptContext;
  sink: GenerationSink;
  usage: AttemptUsage;
  tools: GenerationTools;
  promptDeps: PromptDeps;
  attemptPrompt: AttemptPrompt;
}

/**
 * One model round: budget and compact the transcript, call the model and
 * observe its stream, settle every tool row, and take in steers at the one
 * safe boundary. "stop" when the answer is done.
 */
export const runRound = (env: RoundEnv, round: number) =>
  Effect.gen(function* () {
    const { deps, input, ctx, sink, usage, tools, promptDeps, attemptPrompt } = env;
    const { repo, gateway, sync, providers, analytics, attachments } = deps;
    const { fence, config, model, firstTurn, roundLimit, priorUsage, imageOutput } = ctx;
    const {
      authoring,
      scheduleAuthoring,
      documents,
      webTools,
      knowledgeSession,
      skillTools,
      keepChanges,
      workingFiles,
      knowledgeTools,
      memoryTools,
      memorySpent,
      conversationFiles,
      readable,
      offerState,
      offeredLazy,
      unlockedFamilies,
      schemaTokensWith,
    } = tools;
    const {
      state,
      progress,
      buildBaseTranscript,
      buildTranscript,
      estimateRequestPrompt,
      historyBudgetTail,
      reminderPrompt,
      sourceManifest,
      recordHardTruncation,
      nextPassIndex,
      syncEarlierSkills,
      fixedPrefix,
      historySuffix,
      historyMessages,
      historyGroups,
      maxStartIndex,
      loadedBytes,
      toolkit,
      nonMemoryToolkit,
      firstCallIndex,
    } = attemptPrompt;
    // Rows and chunks are keyed by turn, which a resumed answer
    // continues; budgets and first-call logic count this attempt's rounds.
    const turn = firstTurn + round;
    progress.currentRound = round;
    if (round > 0) yield* keepChanges(workingFiles);
    yield* authoring.refresh();
    yield* scheduleAuthoring.refresh();
    yield* documents.refresh();
    // Direct edits can land between calls. Rebuild before budgeting, not
    // just after the previous batch, so the next call sees current data.
    state.transcript = buildTranscript();
    const factor =
      usage.firstInputTokens !== undefined && usage.estimatedFirstInputTokens !== undefined
        ? calibrationFactor({
            firstInputTokens: usage.firstInputTokens,
            estimatedFirstInputTokens: usage.estimatedFirstInputTokens,
          })
        : calibrationFactor(priorUsage);
    const schemaReserve = round < roundLimit ? (schemaTokensWith(unlockedFamilies) ?? 0) : 0;
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
          summary: state.activeSummary,
          rounds: state.activeRounds,
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
      state.activeSummary = reduced.summary;
      state.activeRounds = reduced.rounds;
      state.transcript = buildTranscript();
    }
    const requestBudget = computeBudget({
      contextLength: model?.contextLength,
      webToolsEnabled: webTools !== undefined,
      toolSchemaTokens: schemaReserve,
    }).input;
    while (Math.ceil(estimateRequestPrompt(round >= roundLimit) * factor) > requestBudget) {
      const active = compileActivePrompt({
        basePrompt: Prompt.empty,
        summary: state.activeSummary,
        rounds: state.activeRounds,
      });
      const shrunk = shrinkForOverflow({
        decision: state.compaction,
        maxStartIndex,
        messages: historySuffix,
        renderedMessages: historyMessages,
        renderedMessageGroups: historyGroups,
        fixedPrefix: [...fixedPrefix, ...(active.content as ReadonlyArray<Prompt.MessageEncoded>)],
        trailingMessages: historyBudgetTail(round >= roundLimit),
        historyReadable: tools.historyTools !== null,
        calibrationFactor: factor,
      });
      if (!shrunk)
        return yield* new ContextTooLarge({
          conversationId: input.conversationId,
          estimatedInputTokens: Math.ceil(estimateRequestPrompt(round >= roundLimit) * factor),
          inputBudget: requestBudget,
        });
      state.compaction = { ...state.compaction, ...shrunk, mode: "truncated" };
      syncEarlierSkills(state.compaction.startIndex);
      state.transcript = buildTranscript();
      yield* recordHardTruncation(turn);
    }
    if (round === 0) usage.estimatedFirstInputTokens = estimateRequestPrompt(false);
    if (skillTools) yield* skillTools.authorize();
    if (knowledgeTools) yield* knowledgeTools.authorize();
    else if (knowledgeSession) yield* knowledgeSession.authorize();
    const toolRoundsLeft = round < roundLimit;
    const turnParts: Response.AnyPart[] = [];
    // Bytes a local read produced for the model this turn. A tool
    // result is text on the wire, so an image or PDF rides as a user
    // file part appended to the round, the way an attachment would.
    const turnFiles: Array<Prompt.UserMessagePartEncoded> = [];
    tools.setPreviewTarget(turnFiles);
    const turnStartOffset = sink.text().length;
    const turnState: TurnState = {
      turn,
      callIndex: round === 0 ? firstCallIndex : 0,
      finishReason: undefined,
      turnStartOffset,
      turnFiles,
      callRowIds: new Map(),
      imageCalls: new Map(),
      callTextOffsets: new Map(),
      integrationSummaries: new Map(),
      sharedSnapshots: new Set(),
    };
    tools.clearCallRows();
    let providerOutputStarted = false;
    const currentReminderPrompt = () => reminderPrompt(!toolRoundsLeft);
    const requestPrompt = () => {
      const trailing = currentReminderPrompt();
      return trailing ? Prompt.concat(state.transcript, trailing) : state.transcript;
    };

    // Suspended so an overflow retry re-reads the shrunken transcript
    // rather than the one the provider just rejected.
    const drain = Effect.suspend(() => {
      // An answer gets one memory save attempt across all tool rounds,
      // including those an interrupted attempt already ran.
      const activeToolkit = memorySpent || memoryTools?.attempted() ? nonMemoryToolkit : toolkit;
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
              yield* observePart(env, turnState, part, isPreliminary);
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
    const runProviderCall = (recoveryStage: number): Effect.Effect<void, unknown, Scope.Scope> =>
      drain.pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const untouched = !providerOutputStarted && turnParts.length === 0;
            if (!(error instanceof ProviderContextOverflow) || !untouched || recoveryStage >= 2) {
              return yield* Effect.fail(error);
            }

            const overflowFactor = currentCalibration();
            const beforeEstimate = Math.ceil(
              estimateRequestPrompt(!toolRoundsLeft) * overflowFactor,
            );
            if (recoveryStage === 0 && state.activeRounds.length > 0) {
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
                  summary: state.activeSummary,
                  rounds: state.activeRounds,
                  beforeTurnIndex: turn,
                  textOffset: sink.text().length,
                  passIndex: nextPassIndex(turn),
                  calibrationFactor: overflowFactor,
                  sourceManifest: sourceManifest(),
                  ...(currentReminderPrompt() ? { trailingPrompt: currentReminderPrompt()! } : {}),
                  force: true,
                  onCompaction: (event) => sink.pushCompaction({ v: 1, ...event }),
                  summaryTokens: summaryTokensFor(model?.contextLength),
                },
              );
              if (reduced.compacted && reduced.estimatedInputTokens < beforeEstimate) {
                state.activeSummary = reduced.summary;
                state.activeRounds = reduced.rounds;
                state.transcript = buildTranscript();
                yield* Effect.logInfo("context overflow, retrying after compacting tool rounds", {
                  messageId: input.messageId,
                  turn,
                });
                return yield* runProviderCall(1);
              }
            }

            const activeOnly = compileActivePrompt({
              basePrompt: Prompt.make([]),
              summary: state.activeSummary,
              rounds: state.activeRounds,
            });
            const shrunk = shrinkForOverflow({
              decision: state.compaction,
              maxStartIndex,
              messages: historySuffix,
              renderedMessages: historyMessages,
              renderedMessageGroups: historyGroups,
              fixedPrefix: [...fixedPrefix, ...promptMessages(activeOnly)],
              trailingMessages: historyBudgetTail(!toolRoundsLeft),
              historyReadable: tools.historyTools !== null,
              calibrationFactor: overflowFactor,
            });
            if (!shrunk) return yield* Effect.fail(error);

            state.compaction = { ...state.compaction, ...shrunk, mode: "truncated" };
            syncEarlierSkills(state.compaction.startIndex);
            state.transcript = buildTranscript();
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
      turnState.finishReason === undefined ||
      turnState.finishReason === "unknown" ||
      turnState.finishReason === "other"
    )
      return yield* Effect.fail(new Error("[ResponseIncomplete]"));
    if (turnState.finishReason === "content-filter")
      return yield* Effect.fail(new Error("[ResponseFiltered]"));
    if (turnState.finishReason === "error") return yield* Effect.fail(new Error("[ResponseError]"));
    // Presenting questions ends the response: entries aimed at this
    // generation stay queued so the answer owns the next turn.
    if (state.questionPresented) return "stop";
    // The answer is done: a steer that did not reach a boundary stays
    // queued, first in line, and goes out as the next turn. It is never
    // bolted onto an answer that already finished.
    if (turnState.finishReason !== "tool-calls") return "stop";
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
    state.activeRounds = [
      ...state.activeRounds,
      {
        turnIndex: turn,
        prompt:
          turnFiles.length === 0
            ? roundMessages
            : Prompt.concat(roundMessages, Prompt.make([{ role: "user", content: turnFiles }])),
      },
    ];
    if (steered.length > 0) {
      progress.steeredAfter = round;
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
      state.activeRounds = [
        ...state.activeRounds,
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
          attachments: files.filter((file) => file.messageId === message.id).map(toAttachmentDto),
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
    state.transcript = buildTranscript();
    return "next" as const;
  });
