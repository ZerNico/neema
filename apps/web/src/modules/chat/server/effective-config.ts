import { Effect } from "effect";
import type { ResolvedAgentConfig } from "~/db/schema/agents.ts";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import { AgentNotAvailable } from "~/modules/agents/errors.ts";
import { KnowledgeRejected } from "~/modules/knowledge/errors.ts";
import { resolveSkillManifest } from "~/modules/skills/server/repo.ts";
import { KnowledgeRepo, type ManifestEntry } from "~/modules/knowledge/server/repo.ts";
import { KNOWLEDGE_CONTEXT_LIMITS } from "~/modules/knowledge/server/context.ts";
import { KNOWLEDGE_LIMITS } from "~/modules/knowledge/schema.ts";
import { COMPACTION_CONFIG, computeBudget } from "./compaction.ts";
import type { GenerationConfig } from "./repo.ts";
import type { ReasoningEffort } from "~/modules/providers/model-config.ts";
import type { DbTx } from "~/server/db.ts";

export type KnowledgeMode = "none" | "context" | "retrieval";

export const resolveAttemptSkills = (
  tx: DbTx | undefined,
  userId: string,
  standaloneIds: readonly string[],
  agentIds: readonly string[],
) => {
  if (!standaloneIds.length && !agentIds.length) return Effect.succeed([]);
  if (!tx) return Effect.die(new Error("Skill attempts require transactional resolution"));
  return resolveSkillManifest(tx, userId, standaloneIds, agentIds).pipe(
    Effect.catchTag("EffectDrizzleQueryError", Effect.die),
  );
};

/**
 * A metadata-only estimate of whether a whole selection could be included
 * directly. It exists to refuse an impossible request before a turn is
 * written; the exact decision needs the rendered prompt and is made again at
 * dispatch, which may still downgrade to retrieval.
 */
export const fitsDirectContext = (input: {
  manifest: ReadonlyArray<ManifestEntry>;
  contextLength: number | null | undefined;
  searchEnabled: boolean;
}): boolean => {
  let chars = 0;
  for (const entry of input.manifest) {
    if (
      entry.status !== "ready" ||
      !entry.versionId ||
      entry.truncated ||
      entry.charCount === null ||
      !Number.isSafeInteger(entry.charCount) ||
      entry.charCount < 1
    )
      return false;
    chars += entry.charCount;
  }
  const budget = computeBudget({
    contextLength: input.contextLength,
    webToolsEnabled: input.searchEnabled,
  });
  return (
    Math.ceil(chars / COMPACTION_CONFIG.charsPerToken) <=
    Math.min(KNOWLEDGE_CONTEXT_LIMITS.tokens, budget.input * KNOWLEDGE_CONTEXT_LIMITS.inputShare)
  );
};

/** One coherent live agent contribution, private to this attempt. */
export interface AgentSelection {
  readonly agentId: string | null;
  readonly resolvedAgent: ResolvedAgentConfig;
}

/**
 * Resolves an agent's current configuration. Reading inside the attempt's
 * transaction is what makes the execution record a configuration that actually
 * existed: an edit bumps `configRevision`, and validating outside the write
 * would persist a revision number that never went with this text.
 */
export const resolveAgentSelection = Effect.fn("chat.resolveAgentSelection")(function* (input: {
  tx: DbTx;
  userId: string;
  agentId: string;
}) {
  const agents = yield* AgentRepo;
  const stored = yield* agents.get(input.userId, input.agentId, input.tx);
  if (!stored) return yield* new AgentNotAvailable({ agentId: input.agentId });
  return {
    agentId: stored.row.id,
    resolvedAgent: {
      agentId: stored.row.id,
      configRevision: stored.row.configRevision,
      name: stored.row.name,
      icon: stored.row.icon,
      instructions: stored.row.instructions,
      collectionIds: stored.collectionIds,
      skillIds: stored.skillIds ?? [],
      customToolIds: stored.customToolIds,
      searchEnabled: stored.row.searchEnabled,
      planEnabled: stored.row.planEnabled,
    },
  } satisfies AgentSelection;
});

/**
 * Resolves what an attempt will run with from its current agent contribution
 * and the original standalone collections chosen in the composer.
 *
 * An agent grant is never a grant to its dependencies: the collections are
 * authorized here, separately, and losing any of them fails the whole
 * selection instead of quietly answering from the part that remains.
 */
export const resolveEffectiveGeneration = Effect.fn("chat.resolveEffectiveGeneration")(
  function* (input: {
    tx?: DbTx;
    userId: string;
    agent?: AgentSelection | null | undefined;
    /** Collections selected in the composer, beside any the agent attaches. */
    collectionIds?: ReadonlyArray<string> | undefined;
    skillIds?: ReadonlyArray<string> | undefined;
    searchEnabled: boolean;
    /** Whether `deep_research` is offered to this attempt. */
    researchEnabled: boolean;
    reasoningEffort?: ReasoningEffort | null;
    /** Folders the sending machine reported; absent when it had none. */
    desktopFolders?: ReadonlyArray<{ name: string; path: string }> | null | undefined;
    desktopCommands?: boolean | undefined;
    desktopBrowser?: boolean | undefined;
    /** Which machine sent it; stamped for the foreign-chat banner. */
    desktopMachineId?: string | null | undefined;
    desktopMachineName?: string | null | undefined;
    /** Workspace files this turn's send claimed; the resolver threads them through. */
    workspaceFiles?: ReadonlyArray<string> | undefined;
    model: { contextLength: number | null | undefined };
    /** Whether web search could run at all; an agent preference cannot force it. */
    searchAvailable: boolean;
  }) {
    const knowledge = yield* KnowledgeRepo;
    const resolvedAgent = input.agent?.resolvedAgent ?? null;
    const collectionIds = [
      ...new Set([...(resolvedAgent?.collectionIds ?? []), ...(input.collectionIds ?? [])]),
    ];
    if (collectionIds.length > KNOWLEDGE_LIMITS.maxCollectionsPerSelection)
      return yield* new KnowledgeRejected({ reason: "select at most five knowledge collections" });

    // Preferences degrade rather than fail: an agent that likes search must not
    // break on an instance that has none. Tool support itself is never a
    // question: models without native calling are polyfilled in the gateway.
    const searchEnabled = input.searchEnabled && input.searchAvailable;
    const planEnabled = resolvedAgent?.planEnabled ?? false;

    const manifest =
      collectionIds.length === 0
        ? []
        : yield* knowledge.resolveManifest(input.userId, collectionIds, input.tx);
    const knowledgeMode: KnowledgeMode =
      collectionIds.length === 0
        ? "none"
        : fitsDirectContext({ manifest, contextLength: input.model.contextLength, searchEnabled })
          ? "context"
          : "retrieval";

    const skillManifest = yield* resolveAttemptSkills(
      input.tx,
      input.userId,
      input.skillIds ?? [],
      resolvedAgent?.skillIds ?? [],
    );
    return {
      standaloneSkillIds: [...(input.skillIds ?? [])],
      skills: skillManifest,
      agentId: input.agent?.agentId ?? null,
      resolvedAgent,
      standaloneCollectionIds: [...(input.collectionIds ?? [])],
      collectionIds,
      manifest,
      knowledgeMode,
      searchEnabled,
      researchEnabled: input.researchEnabled,
      reasoningEffort: input.reasoningEffort ?? null,
      planEnabled,
      // The column holds names alone: paths stay on the machine that granted
      // them, so a conversation continued elsewhere resolves its own folders.
      desktopFolders: input.desktopFolders?.map((folder) => folder.name) ?? null,
      desktopCommands: input.desktopCommands ?? false,
      desktopBrowser: input.desktopBrowser ?? false,
      desktopMachineId: input.desktopMachineId ?? null,
      desktopMachineName: input.desktopMachineName ?? null,
      workspaceFiles: [...(input.workspaceFiles ?? [])],
    } satisfies GenerationConfig;
  },
);
