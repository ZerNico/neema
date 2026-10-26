import { and, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";
import type { ResolvedAgentConfig, UnavailableAgentDependency } from "~/db/schema/agents.ts";
import {
  customTools,
  integrationConfigs,
  knowledgeCollections,
  skills,
} from "~/db/schema/index.ts";
import { customToolUsableBy } from "~/modules/custom-tools/server/repo.ts";
import { integrationUsableBy } from "~/modules/integrations/server/repo.ts";
import { readableBy } from "~/modules/sharing/server/resources.ts";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import { AgentNotAvailable } from "~/modules/agents/errors.ts";
import { KnowledgeRejected } from "~/modules/knowledge/errors.ts";
import { localized } from "~/i18n/localized.ts";
import { m } from "~/paraglide/messages.js";
import { resolveSkillManifest } from "~/modules/skills/server/repo.ts";
import { KnowledgeRepo, type ManifestEntry } from "~/modules/knowledge/server/repo.ts";
import { KNOWLEDGE_CONTEXT_LIMITS } from "~/modules/knowledge/server/context.ts";
import { KNOWLEDGE_LIMITS } from "~/modules/knowledge/schema.ts";
import { COMPACTION_CONFIG, computeBudget } from "./compaction.ts";
import type { GenerationConfig } from "./repo.ts";
import type { ReasoningEffort } from "~/modules/providers/model-config.ts";
import type { DbTx } from "~/server/db.ts";
import type { DesktopSubmission } from "../schema.ts";

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
  readonly resolvedAgent: ResolvedAgentConfig;
  /** Dependencies of that revision the sender cannot use now; the attempt runs without them. */
  readonly unavailable: ReadonlyArray<UnavailableAgentDependency>;
}

type Probe = { id: string; name: string; usable: boolean; readable: boolean };

const probe = (ids: ReadonlyArray<string>, query: () => Effect.Effect<Probe[], unknown>) =>
  ids.length ? query().pipe(Effect.orDie) : Effect.succeed([] as Probe[]);

const missing = (
  kind: UnavailableAgentDependency["kind"],
  ids: ReadonlyArray<string>,
  rows: ReadonlyArray<Probe>,
) =>
  ids.flatMap((id): UnavailableAgentDependency[] => {
    const row = rows.find((candidate) => candidate.id === id);
    if (row?.usable) return [];
    return [{ kind, id, name: row?.readable ? row.name : null }];
  });

/**
 * Which of an agent's dependencies the sender cannot use right now, in the
 * agent's order. A name is kept only where the sender may still read the
 * resource, so a lost share never discloses what it was called.
 */
const unavailableDependencies = Effect.fn("chat.unavailableAgentDependencies")(function* (
  tx: DbTx,
  userId: string,
  agent: Pick<
    ResolvedAgentConfig,
    "collectionIds" | "skillIds" | "customToolIds" | "integrationIds"
  >,
) {
  const collections = yield* probe(agent.collectionIds, () =>
    tx
      .select({
        id: knowledgeCollections.id,
        name: knowledgeCollections.name,
        usable: sql<boolean>`${readableBy("collection", userId)}`,
        readable: sql<boolean>`${readableBy("collection", userId)}`,
      })
      .from(knowledgeCollections)
      .where(inArray(knowledgeCollections.id, [...agent.collectionIds])),
  );
  const skillRows = yield* probe(agent.skillIds, () =>
    tx
      .select({
        id: skills.id,
        name: skills.name,
        // The attempt pins the current revision, so a skill without one cannot load.
        usable: sql<boolean>`${and(
          readableBy("skill", userId),
          sql`exists(select 1 from skill_revisions r where r.skill_id = ${skills.id} and r.revision = ${skills.revision})`,
        )}`,
        readable: sql<boolean>`${readableBy("skill", userId)}`,
      })
      .from(skills)
      .where(inArray(skills.id, [...agent.skillIds])),
  );
  const tools = yield* probe(agent.customToolIds, () =>
    tx
      .select({
        id: customTools.id,
        name: customTools.name,
        usable: sql<boolean>`${customTools.enabled} and ${customToolUsableBy(userId)}`,
        readable: sql<boolean>`${customToolUsableBy(userId)}`,
      })
      .from(customTools)
      .where(inArray(customTools.id, [...agent.customToolIds])),
  );
  const integrations = yield* probe(agent.integrationIds, () =>
    tx
      .select({
        id: integrationConfigs.id,
        name: integrationConfigs.name,
        usable: sql<boolean>`${integrationConfigs.enabled} and ${integrationUsableBy(userId)}`,
        readable: sql<boolean>`${integrationUsableBy(userId)}`,
      })
      .from(integrationConfigs)
      .where(inArray(integrationConfigs.id, [...agent.integrationIds])),
  );
  return [
    ...missing("collection", agent.collectionIds, collections),
    ...missing("skill", agent.skillIds, skillRows),
    ...missing("customTool", agent.customToolIds, tools),
    ...missing("integration", agent.integrationIds, integrations),
  ];
});

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
    unavailable: yield* unavailableDependencies(input.tx, input.userId, stored),
    resolvedAgent: {
      agentId: stored.row.id,
      configRevision: stored.row.configRevision,
      name: stored.row.name,
      icon: stored.row.icon,
      instructions: stored.row.instructions,
      collectionIds: stored.collectionIds,
      skillIds: stored.skillIds,
      customToolIds: stored.customToolIds,
      integrationIds: stored.integrationIds,
      imageModelId: stored.row.imageModelId,
      searchEnabled: stored.row.searchEnabled,
      planEnabled: stored.row.planEnabled,
    },
  } satisfies AgentSelection;
});

/**
 * What an attempt keeps of the desktop report: only whether the sending app could drive
 * embedded pages. A chat's computer is the chat's bound machine, not the sender.
 */
const desktopGenerationConfig = (desktop: DesktopSubmission | undefined) => ({
  desktopBrowser: desktop?.browser ?? false,
});

/**
 * Resolves what an attempt will run with from its current agent contribution
 * and the original standalone collections chosen in the composer.
 *
 * An agent grant is never a grant to its dependencies. What the sender
 * picked themselves must all be usable, or the attempt fails; what the agent
 * brings and the sender can no longer use is left out and recorded, so the
 * answer can say what it ran without.
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
    /** What the sending app reported; absent from a browser. */
    desktop?: DesktopSubmission | undefined;
    model: { contextLength: number | null | undefined };
    /** Whether web search could run at all; an agent preference cannot force it. */
    searchAvailable: boolean;
  }) {
    const knowledge = yield* KnowledgeRepo;
    const resolvedAgent = input.agent?.resolvedAgent ?? null;
    const unavailable = input.agent?.unavailable ?? [];
    const usable = (kind: UnavailableAgentDependency["kind"], ids: ReadonlyArray<string>) =>
      ids.filter((id) => !unavailable.some((entry) => entry.kind === kind && entry.id === id));
    const collectionIds = [
      ...new Set([
        ...usable("collection", resolvedAgent?.collectionIds ?? []),
        ...(input.collectionIds ?? []),
      ]),
    ];
    if (collectionIds.length > KNOWLEDGE_LIMITS.maxCollectionsPerSelection)
      return yield* new KnowledgeRejected({
        reason: localized(m.knowledge_error_select_at_most_five),
      });

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
      usable("skill", resolvedAgent?.skillIds ?? []),
    );
    return {
      standaloneSkillIds: [...(input.skillIds ?? [])],
      skills: skillManifest,
      agentId: resolvedAgent?.agentId ?? null,
      resolvedAgent,
      agentUnavailable: unavailable,
      standaloneCollectionIds: [...(input.collectionIds ?? [])],
      collectionIds,
      manifest,
      knowledgeMode,
      searchEnabled,
      researchEnabled: input.researchEnabled,
      reasoningEffort: input.reasoningEffort ?? null,
      planEnabled,
      ...desktopGenerationConfig(input.desktop),
    } satisfies GenerationConfig;
  },
);
