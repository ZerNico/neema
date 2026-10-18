import { asc, eq } from "drizzle-orm";
import { Effect } from "effect";
import {
  conversationAgents,
  conversationDrafts,
  documents,
  conversations,
  messageGenerationConfig,
  messageSkills,
  messageKnowledgeVersions,
} from "~/db/schema/index.ts";
import { readKeptWorkingFiles } from "../kept-working-files.ts";
import type { DbTx } from "~/modules/attachments/server/repo.ts";
import type {
  GenerationConfig,
  DraftSummary,
  ConversationDefaults,
  ResolveError,
  ResolveGeneration,
} from "../repo.ts";

const draftSummary = (draft: {
  id: string;
  settings: unknown;
  messageId: string;
}): DraftSummary => ({
  id: draft.id,
  name: (draft.settings as { name?: string }).name ?? "",
  messageId: draft.messageId,
});

/** An ordinary generation: no agent, no knowledge, no plan. */
export const PLAIN_GENERATION: GenerationConfig = {
  agentId: null,
  resolvedAgent: null,
  standaloneCollectionIds: [],
  collectionIds: [],
  manifest: [],
  knowledgeMode: "none",
  searchEnabled: false,
  researchEnabled: false,
  reasoningEffort: null,
  planEnabled: false,
};

// ---------------------------------------------------------- generation config

const toConfig = (
  row: typeof messageGenerationConfig.$inferSelect,
  manifest: ReadonlyArray<typeof messageKnowledgeVersions.$inferSelect>,
): GenerationConfig => ({
  agentId: row.agentId,
  resolvedAgent: row.resolvedAgent,
  resolvedProject: row.resolvedProject,
  standaloneCollectionIds: row.standaloneCollectionIds,
  collectionIds: row.collectionIds,
  standaloneSkillIds: row.standaloneSkillIds,
  skills: row.skills,
  manifest: manifest.map((entry) => ({
    collectionId: entry.collectionId,
    documentId: entry.documentId,
    versionId: entry.versionId,
    title: entry.title,
    status: entry.status,
    charCount: entry.charCount,
    truncated: entry.truncated,
  })),
  knowledgeMode: row.knowledgeMode,
  searchEnabled: row.searchEnabled,
  researchEnabled: row.researchEnabled,
  reasoningEffort: row.reasoningEffort,
  planEnabled: row.planEnabled,
  desktopFolders: row.desktopFolders,
  desktopCommands: row.desktopCommands,
  desktopBrowser: row.desktopBrowser,
  desktopMachineId: row.desktopMachineId,
  desktopMachineName: row.desktopMachineName,
  workspaceFiles: row.workspaceFiles,
  integrationGrants: row.integrationGrants,
  imageModel:
    row.imageModelId && row.imageModelName
      ? { id: row.imageModelId, name: row.imageModelName }
      : null,
});

export const readDefaults = Effect.fn("chat.readDefaults")(function* (
  tx: Pick<DbTx, "select">,
  conversationId: string,
) {
  const [agent] = yield* tx
    .select()
    .from(conversationAgents)
    .where(eq(conversationAgents.conversationId, conversationId))
    .pipe(Effect.orDie);
  const drafts = yield* tx
    .select({
      id: conversationDrafts.id,
      kind: conversationDrafts.kind,
      settings: conversationDrafts.settings,
      messageId: conversationDrafts.createdByMessageId,
    })
    .from(conversationDrafts)
    .where(eq(conversationDrafts.conversationId, conversationId))
    .orderBy(asc(conversationDrafts.id))
    .pipe(Effect.orDie);
  const documentRows = yield* tx
    .select({
      id: documents.id,
      title: documents.title,
      // The answer it belongs to, so the transcript can place a card whose
      // creating tool row a rewind took with it. Never any content.
      messageId: documents.createdByMessageId,
    })
    .from(documents)
    .where(eq(documents.conversationId, conversationId))
    .orderBy(asc(documents.id))
    .pipe(Effect.orDie);
  const workingFiles = (yield* readKeptWorkingFiles(tx, conversationId)).map((file) => ({
    id: file.latest.workingFileId,
    name: file.latest.name,
    messageId: file.createdBy,
  }));
  const [conversation] = yield* tx
    .select({
      mode: conversations.mode,
      projectId: conversations.projectId,
      imageModelId: conversations.imageModelId,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .pipe(Effect.orDie);
  return {
    agent: agent ? { agentId: agent.agentId } : null,
    agentDrafts: drafts.filter((draft) => draft.kind === "agent").map(draftSummary),
    scheduleDrafts: drafts.filter((draft) => draft.kind === "schedule").map(draftSummary),
    documents: documentRows,
    workingFiles,
    mode: conversation?.mode ?? "chat",
    projectId: conversation?.projectId ?? null,
    conversationId,
    imageModelId: conversation?.imageModelId ?? null,
  } satisfies ConversationDefaults;
});

/** Internal plain-chat helpers may omit a resolver; agent attempts never may. */
export const resolveAttempt = (
  tx: DbTx,
  defaults: ConversationDefaults,
  resolve: ResolveGeneration | undefined,
  previous?: GenerationConfig,
): Effect.Effect<GenerationConfig, ResolveError> => {
  if (resolve) return resolve(tx, defaults, previous);
  if (defaults.agent || previous?.skills?.length)
    return Effect.die(new Error("Agent and skill attempts require live configuration resolution"));
  return Effect.succeed(previous ?? PLAIN_GENERATION);
};

export const readConfig = Effect.fn("chat.readGenerationConfig")(function* (
  tx: Pick<DbTx, "select">,
  messageId: string,
) {
  const [row] = yield* tx
    .select()
    .from(messageGenerationConfig)
    .where(eq(messageGenerationConfig.messageId, messageId))
    .pipe(Effect.orDie);
  if (!row)
    return yield* Effect.die(new Error(`Missing generation configuration for ${messageId}`));
  const manifest = yield* tx
    .select()
    .from(messageKnowledgeVersions)
    .where(eq(messageKnowledgeVersions.messageId, messageId))
    .orderBy(asc(messageKnowledgeVersions.position))
    .pipe(Effect.orDie);
  return toConfig(row, manifest);
});

/** Writes the effective configuration beside a freshly inserted assistant row. */
export const writeConfig = Effect.fn("chat.writeGenerationConfig")(function* (
  tx: DbTx,
  messageId: string,
  config: GenerationConfig,
) {
  yield* tx
    .insert(messageGenerationConfig)
    .values({
      messageId,
      agentId: config.agentId,
      resolvedAgent: config.resolvedAgent,
      resolvedProject: config.resolvedProject ?? null,
      standaloneCollectionIds: [...config.standaloneCollectionIds],
      standaloneSkillIds: [...(config.standaloneSkillIds ?? [])],
      skills: [...(config.skills ?? [])],
      knowledgeMode: config.knowledgeMode,
      planEnabled: config.planEnabled,
      searchEnabled: config.searchEnabled,
      researchEnabled: config.researchEnabled,
      reasoningEffort: config.reasoningEffort,
      desktopFolders: config.desktopFolders ? [...config.desktopFolders] : null,
      desktopCommands: config.desktopCommands ?? false,
      desktopBrowser: config.desktopBrowser ?? false,
      desktopMachineId: config.desktopMachineId ?? null,
      desktopMachineName: config.desktopMachineName ?? null,
      workspaceFiles: [...(config.workspaceFiles ?? [])],
      collectionIds: [...config.collectionIds],
      integrationGrants: config.integrationGrants ? [...config.integrationGrants] : null,
      imageModelId: config.imageModel?.id ?? null,
      imageModelName: config.imageModel?.name ?? null,
    })
    .pipe(Effect.orDie);
  yield* tx.delete(messageSkills).where(eq(messageSkills.messageId, messageId)).pipe(Effect.orDie);
  if (config.skills?.length)
    yield* tx
      .insert(messageSkills)
      .values(
        config.skills.map((entry, position) => ({
          messageId,
          skillId: entry.skillId,
          revisionId: entry.revisionId,
          explicit: entry.explicit,
          position,
        })),
      )
      .pipe(Effect.orDie);
  if (config.manifest.length > 0)
    yield* tx
      .insert(messageKnowledgeVersions)
      .values(
        config.manifest.map((entry, position) => ({
          messageId,
          versionId: entry.versionId,
          documentId: entry.documentId,
          collectionId: entry.collectionId,
          title: entry.title,
          status: entry.status,
          charCount: entry.charCount,
          truncated: entry.truncated,
          position,
        })),
      )
      .pipe(Effect.orDie);
});
