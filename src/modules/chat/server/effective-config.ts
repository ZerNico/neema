import { Effect } from "effect";
import type { AgentConfigSnapshot } from "~/db/schema/agents.ts";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import type { DbTx } from "~/modules/attachments/server/repo.ts";
import { AgentNotAvailable } from "~/modules/agents/errors.ts";
import { KnowledgeRejected } from "~/modules/knowledge/errors.ts";
import { KnowledgeRepo, type ManifestEntry } from "~/modules/knowledge/server/repo.ts";
import { KNOWLEDGE_CONTEXT_LIMITS } from "~/modules/knowledge/server/context.ts";
import { KNOWLEDGE_LIMITS } from "~/modules/knowledge/schema.ts";
import { InvalidMessage } from "../errors.ts";
import { COMPACTION_CONFIG, computeBudget } from "./compaction.ts";
import type { GenerationConfig } from "./repo.ts";

export type KnowledgeMode = "none" | "context" | "retrieval";

/** One replay policy for retry, edit, and validated question continuations. */
export const validateGenerationModel = (
  config: Pick<GenerationConfig, "knowledgeMode">,
  model: { capabilities: { tools: boolean } },
): Effect.Effect<void, InvalidMessage> =>
  config.knowledgeMode === "retrieval" && !model.capabilities.tools
    ? Effect.fail(
        new InvalidMessage({
          reason: "this answer used knowledge retrieval, which needs a tool-capable model",
        }),
      )
    : Effect.void;

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

/** The agent contribution for a turn: freshly installed, or inherited frozen. */
export interface AgentSelection {
  readonly agentId: string | null;
  readonly snapshot: AgentConfigSnapshot;
}

/**
 * Installs an agent's current configuration. Reading inside the turn's
 * transaction is what makes the stored snapshot a configuration that actually
 * existed: an edit bumps `configRevision`, and validating outside the write
 * would persist a revision number that never went with this text.
 */
export const installAgentSelection = Effect.fn("chat.installAgentSelection")(function* (input: {
  tx: DbTx;
  userId: string;
  agentId: string;
}) {
  const agents = yield* AgentRepo;
  const stored = yield* agents.get(input.userId, input.agentId, input.tx);
  if (!stored) return yield* new AgentNotAvailable({ agentId: input.agentId });
  return {
    agentId: stored.row.id,
    snapshot: {
      agentId: stored.row.id,
      configRevision: stored.row.configRevision,
      name: stored.row.name,
      icon: stored.row.icon,
      instructions: stored.row.instructions,
      collectionIds: stored.collectionIds,
      searchEnabled: stored.row.searchEnabled,
      planEnabled: stored.row.planEnabled,
    },
  } satisfies AgentSelection;
});

/**
 * Resolves what a turn will actually run with, from an already-installed or
 * inherited agent selection plus the collections chosen in the composer.
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
    searchEnabled: boolean;
    model: { capabilities: { tools: boolean }; contextLength: number | null | undefined };
    /** Whether web search could run at all; an agent preference cannot force it. */
    searchAvailable: boolean;
  }) {
    const knowledge = yield* KnowledgeRepo;
    const snapshot = input.agent?.snapshot ?? null;
    const collectionIds = [
      ...new Set([...(snapshot?.collectionIds ?? []), ...(input.collectionIds ?? [])]),
    ];
    if (collectionIds.length > KNOWLEDGE_LIMITS.maxCollectionsPerSelection)
      return yield* new KnowledgeRejected({ reason: "select at most five knowledge collections" });

    // Preferences degrade rather than fail: an agent that likes search must not
    // break on a model or an instance that has none.
    const searchEnabled =
      input.searchEnabled && input.model.capabilities.tools && input.searchAvailable;
    const planEnabled = (snapshot?.planEnabled ?? false) && input.model.capabilities.tools;

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
    if (knowledgeMode === "retrieval" && !input.model.capabilities.tools)
      return yield* new InvalidMessage({
        reason:
          "The selected knowledge does not fit this model's context. Choose a tool-capable model, or select fewer documents.",
      });

    return {
      agentId: input.agent?.agentId ?? null,
      snapshot,
      collectionIds,
      manifest,
      knowledgeMode,
      searchEnabled,
      planEnabled,
    } satisfies GenerationConfig;
  },
);
