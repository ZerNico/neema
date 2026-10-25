import { Effect } from "effect";
import type { CustomToolRepo } from "~/modules/custom-tools/server/repo.ts";
import type { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import type { IntegrationService } from "~/modules/integrations/server/service.ts";
import { supportsImageOutput } from "~/modules/providers/provider-presets.ts";
import type { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { extractUserMessageUrls } from "~/modules/tools/server/user-urls.ts";
import type { Source } from "~/modules/tools/schema.ts";
import { mergeSources } from "~/modules/tools/sources.ts";
import { uiStateContextMessage } from "~/modules/genui/server/ui-state-context.ts";
import type { DesktopSubmission, OpenDocument } from "../../schema.ts";
import { GenerationFence } from "../generation-fence.ts";
import { resumeFirstTurn, type HistorySteer } from "../prompt.ts";
import type { ProviderReplay } from "../provider-replay.ts";
import type { ChatRepo } from "../repo.ts";
import { RESEARCH_TURN_BASE } from "../research/execution.ts";
import { runtimeContextMessage } from "../runtime-context.ts";

// One assistant message may span several model turns when tools are involved:
// model → tool_calls → execute → feed results back → model continues. One
// ceiling for every chat: a runaway loop, not a budget. Per-tool budgets and
// the tools-off final pass still apply.
const MAX_TOOL_ROUNDS = 128;

/** What starts one attempt; the engine adds its stop signal. */
export interface GenerationInput {
  userId: string;
  conversationId: string;
  messageId: string;
  modelId: string;
  /** The attempt's own generation; a stale one finds its row moved on and stops. */
  generationId: string;
  /**
   * The sending app's report, folder paths included. Never stored: the paths
   * exist for this attempt's prompt and tool traffic alone.
   */
  desktop?: DesktopSubmission | undefined;
  /** See `ExternalOwner.deviceSessionId`; taken from the session, not the body. */
  deviceSessionId?: string | undefined;
  timeZone?: string | undefined;
  /** The document open in the panel, so it is the one the model reads first. */
  openDocument?: OpenDocument | undefined;
  /** Continue the answer from its stored rounds instead of starting it over. */
  resume?: boolean | undefined;
}

/**
 * Everything an attempt reads before it does anything: its frozen
 * configuration, the sender's access, the conversation split into settled
 * history and steers, and where a resumed answer left off. Null when a newer
 * attempt already owns the message.
 */
export const loadAttemptContext = (
  deps: {
    repo: ChatRepo["Service"];
    policy: FeaturePolicy["Service"];
    customToolRepo: CustomToolRepo["Service"];
    integrations: IntegrationService["Service"];
    providers: ProviderRepo["Service"];
  },
  input: GenerationInput,
) =>
  Effect.gen(function* () {
    const { repo, policy, customToolRepo, integrations, providers } = deps;
    const fence = yield* GenerationFence;
    const currentMessage = yield* repo.getMessage(input.messageId);
    if (fence && currentMessage?.generationId !== fence.generationId) return null;
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
      agentIntegrationIds: config.resolvedAgent?.integrationIds ?? null,
    });
    const runtimeContext = runtimeContextMessage(new Date(), input.timeZone);
    // Snapshot the model row up front: the ledger wants its display name
    // and pricing even if the admin deletes or reprices it mid-generation.
    const model = yield* providers.getModel(input.modelId);
    const history = yield* repo.listMessages(input.conversationId);
    // What the reader did in earlier answers' blocks, as of this send.
    const uiStateContext = uiStateContextMessage(
      history,
      yield* repo.listUiStates(
        history
          .filter((message) => message.role === "assistant" && message.id !== input.messageId)
          .map((message) => message.id),
      ),
    );
    // A resumed answer starts from what it already produced: its rows are
    // the rounds this attempt continues, read once here.
    const resuming = input.resume === true && currentMessage !== null;
    const ownCalls = resuming ? yield* repo.listToolCalls([input.messageId]) : [];
    const ownCompactions = resuming ? yield* repo.listCompactionEvents([input.messageId]) : [];
    const ownSteers = resuming
      ? history.filter((m) => m.steeredIntoMessageId === input.messageId && m.status === "complete")
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
    const roundLimit = Math.max(0, Math.min(MAX_TOOL_ROUNDS, RESEARCH_TURN_BASE - 1 - firstTurn));
    const settled = history.filter(
      (m) =>
        m.id !== input.messageId &&
        (m.status === "complete" ||
          (m.status !== "streaming" && !!m.assistantOutput?.files.length)),
    );
    // A steer is part of the answer it was delivered into, so it leaves
    // the history list and is rendered inside that answer. One whose
    // answer is not in history went with that attempt. `historyMessage` in
    // `repo.ts` repeats this rule for the history tools; change both together.
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
      rawCompleted.filter((message) => message.role === "assistant").map((message) => message.id),
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
    if (currentSend?.role === "user" && config.workspaceFiles && config.workspaceFiles.length > 0)
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
        history.filter((m) => m.id !== input.messageId && m.role === "assistant").map((m) => m.id),
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
      completed.findLast((m) => m.role === "assistant" && m.usage?.firstInputTokens !== undefined)
        ?.usage ?? null;

    const earlierUsage = resuming ? currentMessage.usage : null;
    // The resume claim set the row's text to what its chunks spell.
    const startSeq = resuming ? yield* repo.lastChunkSeq(input.messageId) : 0;
    // A resumed answer keeps the replay units its model wrote; the resume
    // transaction already cleared them for a different model.
    const replay: ProviderReplay | null = resuming ? (currentMessage.providerReplay ?? null) : null;
    // Image output exists only where the provider's wire format carries it.
    const provider = model
      ? (yield* providers.listProviders()).find((row) => row.id === model.providerId)
      : undefined;
    const imageOutput =
      model?.capabilities.imageOutput === true &&
      provider !== undefined &&
      supportsImageOutput(provider);
    return {
      fence,
      currentMessage,
      config,
      permissions,
      selectedFeatureUnavailable,
      customToolManifests,
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
      readerUrls,
      priorToolCalls,
      priorSources,
      priorUsage,
      earlierUsage,
      imageOutput,
      replay,
      /** Where the sink starts: a resumed answer continues its own chunks and text. */
      start: {
        seq: startSeq,
        text: resuming ? currentMessage.content : "",
        reasoning: resuming ? (currentMessage.reasoning ?? "") : "",
        deliveredFiles: resuming ? (currentMessage.assistantOutput?.files?.length ?? 0) : 0,
      },
    };
  });

export type AttemptContext = NonNullable<Effect.Success<ReturnType<typeof loadAttemptContext>>>;
