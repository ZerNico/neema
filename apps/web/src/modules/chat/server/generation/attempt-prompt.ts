import { ComputerRepo } from "~/modules/computer/server/repo.ts";
import { MachineHub } from "~/modules/computer/server/hub.ts";
import { sentFilePaths } from "~/modules/computer/server/files.ts";
import { computerNotice } from "~/modules/desktop/tool-schema.ts";
import { offeredBuiltins } from "~/modules/skills/bundled/index.ts";
import { SKILL_LIMITS } from "~/modules/skills/package.ts";
import { earlierSkillMessage } from "~/modules/skills/server/tools.ts";
import { isOfficeFamily, officeFamilyOfFile } from "~/modules/office/families.ts";
import { INTERACTIVE_UI_SKILL_ID } from "~/modules/genui/skill.ts";
import { Effect, Option } from "effect";
import { formatQuestionContext, readPresentedQuestions } from "~/modules/tools/ask-user-schema.ts";
import { renderPlanReminder } from "~/modules/tools/plan-schema.ts";
import { Prompt } from "effect/ai";
import { uuidv7 } from "uuidv7";
import { formatFileRef } from "../file-ref.ts";
import { anchorLastMessage, cacheAnchor } from "~/modules/providers/server/gateway.ts";
import {
  prepareKnowledgeContext,
  type PreparedKnowledgeContext,
} from "~/modules/knowledge/server/context.ts";
import { KnowledgeService } from "~/modules/knowledge/server/service.ts";
import { KNOWLEDGE_TOOL_LIMITS } from "~/modules/knowledge/tool-schema.ts";
import { sourceTarget, mergeSource } from "~/modules/tools/sources.ts";
import type { Source } from "~/modules/tools/schema.ts";
import {
  compileActivePrompt,
  computeBudget,
  estimatePromptTokens,
  latestValidCheckpoint,
  prepareCompactedHistory,
  type ActiveRound,
  type CompactionDecision,
} from "../compaction.ts";
import {
  buildHistoryMessages,
  loadResumedImages,
  RESUME_REMINDER,
  inlineTextCharsFor,
  resumedRounds,
  type PromptDeps,
} from "../prompt.ts";
import { buildFixedPrefix } from "../system-prompt.ts";
import type { LoadableToolFamily } from "~/modules/tools/tool-load-schema.ts";
import { buildSearchReminder, MAX_PRIOR_SOURCES, systemReminderMessage } from "../search-prompt.ts";
import type { AttemptContext, GenerationInput } from "./attempt-context.ts";
import type { GenerationDeps } from "./deps.ts";
import type { AttemptUsage, GenerationSink } from "./sink.ts";
import { quotedName, type GenerationTools } from "./tools.ts";
import { json, promptMessages } from "./json.ts";
import type { ProviderReplay } from "../provider-replay.ts";
import {
  blockKey,
  blockName,
  needsOf,
  replayedBlocks,
  replayedOpening,
  resultSources,
  type AnswerOpening,
  type MarkerKind,
  type OpeningAccess,
} from "../answer-opening.ts";

/** Which round an attempt is in, for the reminders that count down or follow a steer. */
export interface RoundProgress {
  currentRound: number;
  /** The round whose results a steer followed; its next call alone is told how to read it. */
  steeredAfter: number | null;
  /** Failures in a row, by tool and the error it gave, for the repeat guard. */
  readonly repeatedFailures: Map<string, number>;
  /** The tool that failed the same way too often; from then on no tools are offered. */
  stuckOn: string | null;
}

/** Identical failures of one tool in a row after which an answer is offered no more tools. */
export const REPEATED_FAILURE_LIMIT = 3;

/** What the hint says about the chat's computer: its machine, whether it is online, its folders. */
const computerState = (
  repo: ComputerRepo["Service"],
  hub: MachineHub["Service"],
  userId: string,
  conversationId: string,
) =>
  Effect.gen(function* () {
    const chat = yield* repo.chat(userId, conversationId);
    const files = sentFilePaths(yield* repo.sentFiles(userId, conversationId)).map(
      (file) => file.path,
    );
    if (!chat?.machineId) return { machine: null, folders: chat?.folders ?? [], files };
    const machine = yield* repo.machine(userId, chat.machineId);
    const online = (yield* hub.presence(userId, chat.machineId)) !== null;
    return {
      machine: { name: machine?.name ?? "the user's computer", online },
      folders: chat.folders,
      files,
    };
  });

/** What the rounds change as the answer goes: its compacted history and active rounds. */
export interface RoundState {
  compaction: CompactionDecision;
  activeSummary: string | null;
  activeRounds: ReadonlyArray<ActiveRound>;
  /** Everything up to the latest round; reminders are appended per request. */
  transcript: Prompt.Prompt;
  questionPresented: boolean;
  replay: ProviderReplay | null;
}

// A block's first line names it ("Application-provided documents…"),
// so an updated block is matched to its earlier snapshot by that line.
const MARKERS_BY_SOURCE: Record<string, ReadonlyArray<MarkerKind>> = {
  documents: ["documents"],
  knowledge: ["knowledge"],
  skills: ["skills"],
  kept: ["working"],
};

const goneMessage = (names: ReadonlyArray<string>): Prompt.MessageEncoded => ({
  role: "user",
  content: `<context-update>\nNo longer current; the earlier snapshot of each no longer applies:\n${names.map((name) => `- ${name}`).join("\n")}\n</context-update>`,
});

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
 * Prepares the attempt's first request: retained history, the fixed prefix,
 * the trailing context and reminders, the initial compaction, direct
 * knowledge and pinned skill rows, and the transcript the rounds continue.
 */
export const prepareAttemptPrompt = (env: {
  deps: GenerationDeps;
  input: GenerationInput;
  ctx: AttemptContext;
  sink: GenerationSink;
  usage: AttemptUsage;
  tools: GenerationTools;
  promptDeps: PromptDeps;
}) =>
  Effect.gen(function* () {
    const { deps, input, ctx, sink, usage, tools, promptDeps } = env;
    const { repo, gateway, providers, analytics, knowledgeService, presentationFonts } = deps;
    const {
      config,
      permissions,
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
    } = ctx;
    const {
      authoring,
      scheduleAuthoring,
      documents,
      indexer,
      webTools,
      interactiveUi,
      knowledgeSession,
      skillManifest,
      skillTools,
      desktopTools,
      browserTools,
      appTools,
      planTools,
      notifyTools,
      officeEditors,
      kept,
      workingFiles,
      imageTool,
      imageNotice,
      publishFileTool,
      keptNotice,
      integrationTools,
      knowledgeTools,
      conversationContext,
      historyTools,
      researchTool,
      offerState,
      offeredLazy,
      lazyCatalog,
      unlockByCall,
      budgetToolkit,
      toolSchemaTokens,
      summaryToolChoice,
    } = tools;
    // Read once: the answer's opening shows it as its first request saw it.
    const computer = desktopTools
      ? yield* computerState(deps.computerRepo, deps.machineHub, input.userId, input.conversationId)
      : null;
    const computerContext: ReadonlyArray<Prompt.MessageEncoded> = computer
      ? [{ role: "user", content: computerNotice(computer) }]
      : [];
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
    if (completed.at(-1)?.role === "user" && questionContexts.has(completed.at(-2)?.id ?? "")) {
      protectedStart = completed.length - 2;
      while (protectedStart > 0 && completed[protectedStart]?.role !== "user") protectedStart--;
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
    const maxStartIndex = protectedStart === undefined ? undefined : protectedStart - suffixStart;
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
        listToolCalls: (ids) => Effect.succeed(ids.flatMap((id) => callsByMessage.get(id) ?? [])),
      },
    };
    // What the previous request advertised: families its retained history
    // (everything after the last checkpoint) had loaded. The summary
    // repeats that list so it reads the cached prefix; the schema budget in
    // tools.ts keeps the wider set as an upper bound.
    const priorUnlocked = new Set<LoadableToolFamily>();
    if (offeredLazy.length) {
      const suffixIds = new Set(historySuffix.map((message) => message.id));
      for (const call of priorToolCalls)
        if (
          call.researchRunId === null &&
          (suffixIds.has(call.messageId) || call.messageId === input.messageId)
        )
          unlockByCall(priorUnlocked, call);
      for (const file of kept) if (isOfficeFamily(file.owner)) priorUnlocked.add(file.owner);
      for (const file of yield* promptDeps.attachments.listWithBlobsForMessages([...suffixIds])) {
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
    // An earlier answer's opening goes back where it was sent, so this
    // request extends that answer's first one; access is checked again now.
    const openingAccess: OpeningAccess = {
      documents: new Set(permissions.documents ? documents.knownIds() : []),
      knowledge: new Set(knowledgeSession?.manifest.map((entry) => entry.documentId) ?? []),
      skills: new Set(skillTools?.skillIds() ?? []),
      skillRevisions: new Set(skillTools?.skillRevisions() ?? []),
      working: new Set(
        publishFileTool
          ? kept.flatMap((file) => (file.ref.kind === "working" ? [file.ref.id] : []))
          : [],
      ),
      features: new Set([
        ...(permissions.agentsCreate ? ["agents"] : []),
        ...(permissions.schedules ? ["schedules"] : []),
        ...(permissions.documents ? ["documents"] : []),
        ...(config.resolvedProject ? [`project:${config.resolvedProject.id}`] : []),
        ...(knowledgeSession ? ["knowledge"] : []),
        ...(skillTools ? ["skills"] : []),
        ...(imageTool ? ["images"] : []),
      ]),
    };
    const openingOf = (message: (typeof historySuffix)[number]) =>
      message.role === "assistant" ? replayedOpening(message.opening, openingAccess) : [];
    // Counted toward the budget, never summarized: each attempt shows them again.
    const replayedOpenings = new Set(historySuffix.flatMap(openingOf));
    const historyGroups: Array<ReadonlyArray<Prompt.MessageEncoded>> = [];
    const ownMessages: Prompt.MessageEncoded[] = [];
    for (const message of historySuffix) {
      const own = [
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
      ];
      ownMessages.push(own[0]!);
      historyGroups.push([...openingOf(message), ...own]);
    }
    // Compaction indexes stored rows; each representative's full group is
    // supplied alongside it for token estimates and summary input.
    const historyMessages = ownMessages;
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
    // A changed checklist is sent whole, after the earlier ones still in the
    // transcript; the newest reads as the current one.
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
    const progress: RoundProgress = {
      currentRound: 0,
      steeredAfter: null,
      repeatedFailures: new Map(),
      stuckOn: null,
    };
    // Unfinished drafts by reference; a name is file data, so it is quoted.
    const draftList = () =>
      workingFiles
        .unfinished()
        .map((file) => `${formatFileRef(file.ref)} ${quotedName(file.name)}`)
        .join(", ");
    // Only where drafts can exist, and only near the end.
    const draftReminder = (lastCycle: boolean) => {
      const roundsRemaining = Math.max(0, roundLimit - progress.currentRound);
      if (!publishFileTool || roundsRemaining > 8) return null;
      const drafts = draftList();
      return lastCycle
        ? `No tool rounds remain. Unpublished working files (${drafts || "none"}) cannot be delivered in this response; edited drafts stay in this chat for a later answer. Do not claim they are attached.`
        : `Tool rounds remaining: ${roundsRemaining}. ${drafts ? `Publish unfinished working files before tools become unavailable: ${drafts}.` : "Finish the response when ready."}`;
    };
    // A sent reminder stays ahead of the round it produced (`keepReminder`),
    // so the next request extends this one exactly and a provider that caches
    // at the end of a request reads it all. A later reminder says only what
    // changed, so the newest of each kind is current.
    const told = {
      sections: new Map<string, string>(),
      sources: new Set<number>(),
      // The latest copy of each changed data block, by its header line.
      updates: new Map<string, string>(),
      // A source this answer found is in its tool results, until compaction clears
      // them; a resumed answer's earlier rounds come back as summaries only.
      ownSourcesShown: !resuming,
    };
    const earlierSources = new Set(priorSources.map((source) => source.index));
    const telling = new WeakMap<Prompt.Prompt, () => void>();
    const sentAs = new WeakMap<
      Prompt.Prompt,
      { messages: ReadonlyArray<Prompt.MessageEncoded>; sources: ReadonlyArray<number> }
    >();
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- key is a one-line comparison read where it is used
    const key = (message: Prompt.MessageEncoded) => JSON.stringify(message.content);
    const reminderPrompt = (lastCycle: boolean) => {
      const listed = shownBefore().sources;
      const fresh = recapSources().filter(
        (source) =>
          !told.sources.has(source.index) &&
          !listed.has(source.index) &&
          (earlierSources.has(source.index) || !told.ownSourcesShown),
      );
      // Named, so a section is compared with its own last copy: a state that
      // comes back after another is said again, and a note that stopped
      // applying is said again when it next applies.
      const slots: Record<string, string | null> = {
        resume: resuming && progress.currentRound === 0 ? RESUME_REMINDER : null,
        drafts: draftReminder(lastCycle),
        search: webTools ? buildSearchReminder({ sources: fresh, lastCycle }) || null : null,
        citations: citesNothing
          ? "Citation markers like [^1] in earlier answers point at sources from earlier turns. This answer has no sources to cite, so write no citation markers."
          : null,
        // Arriving after tool results, a bare user message reads like a new
        // turn, and models answered a progress question then stopped.
        steer:
          progress.steeredAfter === progress.currentRound - 1
            ? "The user sent the message above while you were working. Address it briefly, then continue the task unless it asks you to stop or change course."
            : null,
        knowledge: knowledgeReminder(),
        notified: notifiedBefore
          ? "Earlier answers here that called notify_user were scheduled runs, and those notifications were sent. Only a run can notify; this reply is not one, so you cannot notify now. The next run can."
          : null,
        skills:
          skillTools && skillTools.remaining() < SKILL_LIMITS.operations
            ? `Skill operations remaining: ${skillTools.remaining()} of ${SKILL_LIMITS.operations}.`
            : null,
        plan: planReminder(),
        stuck: progress.stuckOn
          ? `${progress.stuckOn} failed the same way ${REPEATED_FAILURE_LIMIT} times in a row, so no tools are offered for the rest of this answer. Answer with what you have and say plainly what you could not do.`
          : null,
      };
      const sections = Object.entries(slots).flatMap(([slot, text]) =>
        text && told.sections.get(slot) !== text ? [text] : [],
      );
      const changed = contextUpdates();
      const changedHeaders = new Set(changed.map(headerOf));
      // A block that went back to how the answer first saw it is no longer an
      // update, but the model last saw it changed: show the first view again.
      const reverted = (answerContext ?? []).filter((message) => {
        const header = headerOf(message);
        return header && told.updates.has(header) && !changedHeaders.has(header);
      });
      const updates = [
        ...changed.filter((message) => told.updates.get(headerOf(message)) !== key(message)),
        ...reverted,
      ];
      // Context data rides as assistant messages (documents), and a request
      // that ends on one is a prefill, which some models refuse outright.
      if (sections.length === 0 && updates.at(-1)?.role === "assistant")
        sections.push("The application data above is current. Continue the answer.");
      const messages = [
        ...updates,
        ...(sections.length > 0 ? [systemReminderMessage(sections.join("\n\n"))] : []),
      ];
      if (messages.length === 0) return null;
      const prompt = Prompt.make(messages);
      // Only a recap that went out lists its sources.
      const recapped = slots["search"] !== null && sections.includes(slots["search"]!);
      sentAs.set(prompt, {
        messages,
        sources: recapped ? fresh.map((source) => source.index) : [],
      });
      telling.set(prompt, () => {
        for (const [slot, text] of Object.entries(slots))
          if (text) told.sections.set(slot, text);
          else told.sections.delete(slot);
        for (const source of fresh) told.sources.add(source.index);
        for (const message of reverted) told.updates.delete(headerOf(message));
        for (const message of changed) told.updates.set(headerOf(message), key(message));
      });
      return prompt;
    };
    /** The reminder a request was sent with is now part of the transcript. */
    const keepReminder = (reminder: Prompt.Prompt) => telling.get(reminder)?.();
    /** Compaction dropped kept reminders with their rounds: say it all again. */
    const forgetReminders = () => {
      told.sections.clear();
      told.sources.clear();
      told.updates.clear();
      told.ownSourcesShown = false;
    };
    // Each block knows what rendered it: an opening stores that as what the
    // block needs, and a source's blocks are sent again together, so data and
    // the line about it never part.
    const blockSources = new WeakMap<
      Prompt.MessageEncoded,
      { source: string; features: ReadonlyArray<string> }
    >();
    const sourced = (
      source: string,
      features: ReadonlyArray<string>,
      messages: ReadonlyArray<Prompt.MessageEncoded>,
    ) => {
      for (const message of messages) blockSources.set(message, { source, features });
      return messages;
    };
    const documentFeatures = [
      "documents",
      ...(config.resolvedProject ? [`project:${config.resolvedProject.id}`] : []),
    ];
    // Everything after retained history, in order: the one list both the
    // transcript and the compaction budget read, so all of it is budgeted.
    const trailingContext = (): ReadonlyArray<Prompt.MessageEncoded> => [
      ...(permissions.agentsCreate ? sourced("agents", ["agents"], authoring.messages()) : []),
      ...(permissions.schedules
        ? sourced("schedules", ["schedules"], scheduleAuthoring.messages())
        : []),
      ...(permissions.documents
        ? sourced("documents", documentFeatures, documents.messages())
        : []),
      ...sourced("knowledge", ["knowledge"], knowledgeContext?.messages ?? []),
      ...sourced("skills", ["skills"], skillTools?.messages() ?? []),
      ...sourced("kept", [], keptNotice),
      ...sourced("images", ["images"], imageNotice),
      ...sourced("computer", [], computerContext),
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
      const before = new Set(answerContext.map(key));
      const headers = new Set(now.map(headerOf));
      // A block that vanished (a cleared draft, a removed document) says
      // so; its snapshot ahead of the rounds would otherwise still read as current.
      const gone = answerContext.map(headerOf).filter((header) => header && !headers.has(header));
      return [
        ...now.filter((message) => !before.has(key(message))),
        ...(gone.length ? [goneMessage(gone)] : []),
      ];
    };
    // What retained history's openings already show, by block, and which
    // earlier sources their reminders listed. Kept per retained start, since
    // compaction can drop the openings they came from.
    let shown: {
      startIndex: number;
      blocks: ReadonlyMap<string, string>;
      sources: ReadonlySet<number>;
    } | null = null;
    // Budgeting before the first compaction assumes all history is kept.
    let roundState: RoundState | null = null;
    const shownBefore = () => {
      const startIndex = roundState?.compaction.startIndex ?? 0;
      if (shown?.startIndex === startIndex) return shown;
      const blocks = new Map<string, string>();
      const sources = new Set<number>();
      // A source whose tool result history still shows needs no recap: the
      // result names it by index, title and address already.
      for (const message of historyGroups.slice(startIndex).flat())
        if (message.role === "tool")
          for (const part of message.content)
            if (part.type === "tool-result")
              for (const index of resultSources(part.result)) sources.add(index);
      for (const message of historySuffix.slice(startIndex)) {
        if (message.role !== "assistant" || !message.opening) continue;
        for (const block of replayedBlocks(message.opening, openingAccess)) {
          if (block.gone) for (const name of block.gone) blocks.delete(name);
          else if (!block.reminder) blocks.set(blockName(block.message), blockKey(block.message));
          for (const index of block.sources ?? []) sources.add(index);
        }
      }
      shown = { startIndex, blocks, sources };
      return shown;
    };
    // This answer's data as its first request sends it: only what history's
    // openings do not already show, and the clock, which always comes last so
    // the request never ends on a data block.
    let opening: {
      startIndex: number;
      messages: ReadonlyArray<Prompt.MessageEncoded>;
      gone: { message: Prompt.MessageEncoded; names: ReadonlyArray<string> } | null;
    } | null = null;
    const answerOpening = () => {
      const before = shownBefore();
      if (opening?.startIndex === before.startIndex) return opening.messages;
      const context = startContext();
      const names = new Set(context.map(blockName));
      const gone = [...before.blocks.keys()].filter((name) => !names.has(name));
      const goneLine = gone.length ? goneMessage(gone) : null;
      const changed = (message: Prompt.MessageEncoded) =>
        before.blocks.get(blockName(message)) !== blockKey(message);
      const resent = new Set(
        context.filter(changed).flatMap((message) => blockSources.get(message)?.source ?? []),
      );
      const messages = [
        ...context.filter(
          (message, index) =>
            index === context.length - 1 ||
            changed(message) ||
            resent.has(blockSources.get(message)?.source ?? ""),
        ),
        ...(goneLine ? [goneLine] : []),
      ];
      opening = {
        startIndex: before.startIndex,
        messages,
        gone: goneLine ? { message: goneLine, names: gone } : null,
      };
      return messages;
    };
    /** What to keep on the answer for history: its opening and the first reminder it sent. */
    const openingRecord = (reminder: Prompt.Prompt | null): AnswerOpening => {
      const sent = reminder ? sentAs.get(reminder) : undefined;
      const listed = sent?.messages.at(-1);
      return {
        v: 1,
        blocks: [...answerOpening(), ...(sent?.messages ?? [])].map((message) => {
          const source = blockSources.get(message);
          const fromReminder = sent?.messages.includes(message) === true;
          // A block is held to the markers its own source writes; the
          // reminder names kept drafts near the end of an answer.
          const parsed = needsOf(
            message,
            source ? (MARKERS_BY_SOURCE[source.source] ?? []) : fromReminder ? ["working"] : [],
          );
          const features = source?.features ?? [];
          const needs = features.length ? { ...parsed, features } : parsed;
          const sources = message === listed && sent?.sources.length ? sent.sources : undefined;
          const gone = message === opening?.gone?.message ? opening.gone.names : undefined;
          return {
            message,
            ...(needs ? { needs } : {}),
            ...(sources ? { sources } : {}),
            ...(gone ? { gone } : {}),
            ...(fromReminder ? { reminder: true as const } : {}),
          };
        }),
      };
    };
    // Reminders are appended per request rather than stored in the
    // transcript, so only the budget adds them to the tail.
    const historyBudgetTail = (lastCycle: boolean): ReadonlyArray<Prompt.MessageEncoded> => [
      ...(answerContext ? answerOpening() : trailingContext()),
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
      lazyFamilies: lazyCatalog,
      images: imageTool !== undefined,
      history: historyTools ? { otherChats: conversationContext.pastChats } : null,
      authoringSkills: offeredBuiltins(tools.skillManifest),
      documents: permissions.documents,
      knowledge: !!knowledgeSession,
      web: webTools ? webTools.tools : null,
      integrations: integrationTools
        ? [
            ...new Set(
              [...integrationTools.names.values()].map(
                (entry) =>
                  integrationOffer.find(
                    (offer) => offer.session.integration.id === entry.integrationId,
                  )?.session.integration.name ?? entry.integrationId,
              ),
            ),
          ]
        : null,
      research: !!researchTool,
      desktop: computer !== null,
      browser: !!browserTools,
      apps: !!appTools,
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
    const state: RoundState = {
      compaction: yield* prepareCompactedHistory(
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
          unsummarized: replayedOpenings,
          fixedPrefix,
          trailingMessages: historyBudgetTail(false),
          webToolsEnabled: webTools !== undefined,
          historyReadable: historyTools !== null,
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
      ),
      activeSummary: null,
      // Set below, once the resumed rounds and the transcript are built.
      activeRounds: [],
      transcript: Prompt.empty,
      questionPresented: false,
      replay: ctx.replay,
    };
    roundState = state;
    syncEarlierSkills(state.compaction.startIndex);

    // What retained history already worked with stays loaded: an explicit
    // load, a lazy tool it called, an authoring skill it loaded, a kept
    // draft or an attached Office file. Decided once, so a later hard
    // truncation in this answer never takes a family away mid-answer.
    yield* tools.unlockRetained(
      new Set(historySuffix.slice(state.compaction.startIndex).map((m) => m.id)),
    );

    // Selected knowledge, decided against the exact rendered prompt: the
    // turn-time mode is a ceiling ("context" may still downgrade to
    // retrieval here), never the reverse. Sits after retained history and
    // before the runtime block, itself part of the protected trailing
    // context, so overflow repair drops history turns, not document
    // bodies.
    if (knowledgeSession && config) {
      const baseMessages = [
        ...fixedPrefix,
        ...state.compaction.injectedMessages,
        ...historyGroups.slice(state.compaction.startIndex).flat(),
        ...historyBudgetTail(false),
      ];
      const prepare = (base: ReadonlyArray<Prompt.MessageEncoded>) =>
        prepareKnowledgeContext({
          userId: input.userId,
          session: knowledgeSession,
          indexer,
          mode: config.knowledgeMode === "retrieval" ? "retrieval" : "context",
          budget: computeBudget({
            contextLength: model?.contextLength,
            webToolsEnabled: webTools !== undefined,
          }),
          baseMessages: base,
          toolSchemaTokens,
          toolResultReserveTokens: knowledgeTools ? KNOWLEDGE_TOOL_LIMITS.resultTokens : 0,
          priorUsage,
        }).pipe(Effect.provideService(KnowledgeService, knowledgeService));
      // The newest replayed evidence is this turn's when nothing changed, and
      // then it is not sent twice: sized without it, and again with it only
      // when the evidence did change and both copies go out.
      const replayedEvidence =
        historySuffix
          .slice(state.compaction.startIndex)
          .map((message) =>
            message.role === "assistant"
              ? replayedBlocks(message.opening, openingAccess)
                  .filter((block) => block.needs?.features?.includes("knowledge"))
                  .map((block) => block.message)
              : [],
          )
          .findLast((blocks) => blocks.length > 0) ?? [];
      const replayed = new Set(replayedEvidence);
      let prepared = yield* prepare(baseMessages.filter((message) => !replayed.has(message)));
      if (
        replayed.size > 0 &&
        prepared.messages.map(blockKey).join("\n") !== replayedEvidence.map(blockKey).join("\n")
      )
        prepared = yield* prepare(baseMessages);
      knowledgeContext = prepared;
      offerState.retrievalEnabled = prepared.mode === "retrieval";
      for (const source of prepared.activity?.sources ?? [])
        sourcesByIndex.set(source.index, mergeSource(sourcesByIndex.get(source.index), source));
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
          family: "knowledge",
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
          (call) => call.researchRunId === null && call.providerCallId.startsWith("skill-context:"),
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
        family: "skill",
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
    for (let index = state.compaction.startIndex; index < historySuffix.length; index++) {
      const message = historySuffix[index]!;
      retainedHistory.set(index, [
        ...openingOf(message),
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
        ...state.compaction.injectedMessages,
        ...historyMessages
          .slice(state.compaction.startIndex)
          .flatMap(
            (message, index) =>
              retainedHistory.get(index + state.compaction.startIndex) ?? [message],
          ),
      ];
      const last = stable.length - 1;
      // Where the newest answer's first request ended: Claude looks back only
      // about twenty blocks from an anchor, and that answer's rounds can be more.
      const openingEnd = historySuffix
        .slice(state.compaction.startIndex)
        .map(openingOf)
        .findLast((replayed) => replayed.length > 0)
        ?.at(-1);
      return Prompt.make([
        ...stable.map((message, index) =>
          (index === last && index > lastSystem) || message === openingEnd
            ? cacheAnchor(message)
            : message,
        ),
        ...answerOpening(),
      ]);
    };
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
    state.activeRounds = resumedRounds({
      content: sink.text(),
      calls: ownCalls,
      files: ownFiles,
      imageParts,
      replay: state.replay,
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
        summary: state.activeSummary,
        rounds: state.activeRounds.map((round, index) =>
          index >= state.activeRounds.length - 2
            ? { ...round, prompt: anchorLastMessage(round.prompt) }
            : round,
        ),
      });

    state.transcript = buildTranscript();
    // The request as sent, its closing cache anchor included, so the estimate
    // and the provider's count describe the same bytes.
    const estimateRequestPrompt = (lastCycle: boolean) => {
      const trailing = reminderPrompt(lastCycle);
      return estimatePromptTokens(
        promptMessages(
          anchorLastMessage(
            trailing ? Prompt.concat(state.transcript, trailing) : state.transcript,
          ),
        ),
      );
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

    return {
      state,
      progress,
      buildBaseTranscript,
      buildTranscript,
      estimateRequestPrompt,
      historyBudgetTail,
      reminderPrompt,
      keepReminder,
      forgetReminders,
      openingRecord,
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
      sourcesByIndex,
      toolkit,
      nonMemoryToolkit,
      firstCallIndex,
    };
  });

export type AttemptPrompt = Effect.Success<ReturnType<typeof prepareAttemptPrompt>>;
