import { findIntegration } from "~/modules/integrations/catalog.ts";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { uuidv7 } from "uuidv7";
import {
  agents,
  agentCollections,
  agentCustomTools,
  agentSkills,
  customTools,
  skills,
  knowledgeCollections,
  user,
  agentIntegrations,
} from "~/db/schema/index.ts";
import type { DbTx } from "~/modules/attachments/server/repo.ts";
import { agentReadable, collectionReadable } from "~/modules/knowledge/server/access.ts";
import { skillReadable } from "~/modules/skills/server/access.ts";
import { Db } from "~/server/db.ts";
import { customToolUsableBy } from "~/modules/custom-tools/server/repo.ts";
import { capabilityAllowedSql } from "~/modules/groups/server/policy.ts";
import { AgentNotAvailable, AgentRejected } from "../errors.ts";
import {
  AGENT_LIMITS,
  type AgentSettings,
  type AgentSummary,
  type UpdateAgentInput,
} from "../schema.ts";

type AgentRow = typeof agents.$inferSelect;
export interface StoredAgent {
  row: AgentRow;
  ownerName: string | null;
  collectionIds: ReadonlyArray<string>;
  skillIds?: ReadonlyArray<string>;
  customToolIds: ReadonlyArray<string>;
  integrationIds: ReadonlyArray<string>;
}
const owned = (userId: string, agentId: string) =>
  and(
    eq(agents.id, agentId),
    eq(agents.userId, userId),
    capabilityAllowedSql(userId, "agentsCreate"),
  );
export const summarizeAgent = (
  row: Pick<
    AgentRow,
    "id" | "name" | "description" | "icon" | "audience" | "configRevision" | "userId" | "updatedAt"
  >,
  ownerName: string | null,
  userId: string,
): AgentSummary => ({
  id: row.id,
  name: row.name,
  description: row.description,
  icon: row.icon,
  audience: row.audience,
  configRevision: row.configRevision,
  canEdit: row.userId === userId,
  ownerName: row.userId === userId ? null : ownerName,
  updatedAt: row.updatedAt.toISOString(),
});

export class AgentRepo extends Context.Service<
  AgentRepo,
  {
    list(userId: string): Effect.Effect<ReadonlyArray<AgentSummary>>;
    /**
     * Readable agent plus its saved collection ids. `tx` runs the read inside a
     * caller's transaction: an installed configuration must be the one that was
     * atomically read, not one an edit bumped between validation and the write.
     */
    get(userId: string, agentId: string, tx?: DbTx): Effect.Effect<StoredAgent | null>;
    saveInTransaction(
      tx: DbTx,
      userId: string,
      input: AgentSettings,
      update?: { agentId: string; expectedRevision: number },
    ): Effect.Effect<
      { agentId: string; configRevision: number },
      AgentNotAvailable | AgentRejected
    >;
    create(userId: string, input: AgentSettings): Effect.Effect<string, AgentRejected>;
    update(
      userId: string,
      input: UpdateAgentInput,
    ): Effect.Effect<void, AgentNotAvailable | AgentRejected>;
    remove(userId: string, agentId: string): Effect.Effect<boolean>;
  }
>()("chat/agents/AgentRepo") {
  static readonly layer = Layer.effect(
    AgentRepo,
    Effect.gen(function* () {
      const db = yield* Db;
      const saveInTransaction = Effect.fn("AgentRepo.saveInTransaction")(function* (
        tx: DbTx,
        userId: string,
        input: AgentSettings,
        update?: { agentId: string; expectedRevision: number },
      ) {
        return yield* Effect.gen(function* () {
          const id = update?.agentId ?? uuidv7();
          if (update) {
            const [current] = yield* tx
              .select()
              .from(agents)
              .where(owned(userId, id))
              .for("update");
            if (!current) return yield* new AgentNotAvailable({ agentId: id });
            if (current.configRevision !== update.expectedRevision)
              return yield* new AgentRejected({
                reason: "agent changed; reload before saving",
              });
          } else {
            const [owner] = yield* tx
              .select({ id: user.id })
              .from(user)
              .where(and(eq(user.id, userId), capabilityAllowedSql(userId, "agentsCreate")))
              .for("update");
            if (!owner)
              return yield* new AgentRejected({ reason: "agent creation is unavailable" });
            const [count] = yield* tx
              .select({ value: sql<number>`count(*)::int` })
              .from(agents)
              .where(eq(agents.userId, userId));
            if (!owner || (count?.value ?? 0) >= AGENT_LIMITS.maxPerUser)
              return yield* new AgentRejected({ reason: "agent limit reached" });
          }
          const {
            collectionIds,
            skillIds = [],
            customToolIds = [],
            integrationIds = [],
            ...settings
          } = input;
          if (integrationIds.some((integrationId) => !findIntegration(integrationId)))
            return yield* new AgentRejected({ reason: "a selected integration does not exist" });
          if (skillIds.length) {
            const available = yield* tx
              .select({ id: skills.id })
              .from(skills)
              .where(and(inArray(skills.id, [...skillIds]), skillReadable(userId)));
            if (available.length !== skillIds.length)
              return yield* new AgentRejected({ reason: "a selected skill is unavailable" });
          }
          if (customToolIds.length) {
            const available = yield* tx
              .select({ id: customTools.id })
              .from(customTools)
              .where(and(inArray(customTools.id, [...customToolIds]), customToolUsableBy(userId)));
            if (available.length !== customToolIds.length)
              return yield* new AgentRejected({ reason: "a selected custom tool is unavailable" });
          }
          if (collectionIds.length) {
            const available = yield* tx
              .select({ id: knowledgeCollections.id })
              .from(knowledgeCollections)
              .where(
                and(
                  inArray(knowledgeCollections.id, [...collectionIds]),
                  collectionReadable(userId),
                ),
              );
            if (available.length !== collectionIds.length)
              return yield* new AgentRejected({
                reason: "a selected collection is unavailable",
              });
          }
          const values = { ...settings, starters: [...settings.starters] };
          if (update) {
            yield* tx
              .update(agents)
              .set({
                ...values,
                configRevision: sql`${agents.configRevision} + 1`,
                updatedAt: new Date(),
              })
              .where(owned(userId, id));
            yield* tx.delete(agentCollections).where(eq(agentCollections.agentId, id));
            yield* tx.delete(agentSkills).where(eq(agentSkills.agentId, id));
            yield* tx.delete(agentCustomTools).where(eq(agentCustomTools.agentId, id));
            yield* tx.delete(agentIntegrations).where(eq(agentIntegrations.agentId, id));
          } else {
            yield* tx.insert(agents).values({ id, userId, ...values });
          }
          if (collectionIds.length)
            yield* tx.insert(agentCollections).values(
              collectionIds.map((collectionId, position) => ({
                agentId: id,
                collectionId,
                position,
              })),
            );
          if (skillIds.length)
            yield* tx
              .insert(agentSkills)
              .values(skillIds.map((skillId, position) => ({ agentId: id, skillId, position })));
          if (customToolIds.length)
            yield* tx
              .insert(agentCustomTools)
              .values(customToolIds.map((toolId, position) => ({ agentId: id, toolId, position })));
          if (integrationIds.length)
            yield* tx.insert(agentIntegrations).values(
              integrationIds.map((integrationId, position) => ({
                agentId: id,
                integrationId,
                position,
              })),
            );
          return { agentId: id, configRevision: update ? update.expectedRevision + 1 : 1 };
        }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die));
      });
      const save = (
        userId: string,
        input: AgentSettings,
        update?: { agentId: string; expectedRevision: number },
      ) =>
        db
          .transaction((tx) => saveInTransaction(tx, userId, input, update))
          .pipe(
            Effect.map(({ agentId }) => agentId),
            Effect.catchTag("SqlError", Effect.die),
          );
      return AgentRepo.of({
        saveInTransaction,
        list: Effect.fn("AgentRepo.list")(function* (userId) {
          const rows = yield* db
            .select({
              row: {
                id: agents.id,
                name: agents.name,
                description: agents.description,
                icon: agents.icon,
                audience: agents.audience,
                configRevision: agents.configRevision,
                userId: agents.userId,
                updatedAt: agents.updatedAt,
              },
              ownerName: user.name,
            })
            .from(agents)
            .innerJoin(user, eq(user.id, agents.userId))
            .where(agentReadable(userId))
            .orderBy(asc(agents.name), asc(agents.id))
            .pipe(Effect.orDie);
          return rows.map(({ row, ownerName }) => summarizeAgent(row, ownerName, userId));
        }),
        get: Effect.fn("AgentRepo.get")(function* (userId, agentId, tx) {
          // Serialize attempt resolution against edits and sharing changes, then read
          // the revision and its dependencies together from a fresh statement.
          if (tx)
            yield* tx
              .select({ id: agents.id })
              .from(agents)
              .where(eq(agents.id, agentId))
              .for("share")
              .pipe(Effect.orDie);
          const [result] = yield* (tx ?? db)
            .select({
              row: agents,
              ownerName: user.name,
              skillIds: sql<
                string[]
              >`array(select ask.skill_id from agent_skills ask where ask.agent_id = ${agents.id} order by ask.position)`,
              customToolIds: sql<
                string[]
              >`array(select act.tool_id from agent_custom_tools act where act.agent_id = ${agents.id} order by act.position)`,
              integrationIds: sql<
                string[]
              >`array(select ai.integration_id from agent_integrations ai where ai.agent_id = ${agents.id} order by ai.position)`,
              collectionIds: sql<
                string[]
              >`array(select ac.collection_id from agent_collections ac where ac.agent_id = ${agents.id} order by ac.position)`,
            })
            .from(agents)
            .innerJoin(user, eq(user.id, agents.userId))
            .where(and(eq(agents.id, agentId), agentReadable(userId)))
            .pipe(Effect.orDie);
          return result ?? null;
        }),
        create: (userId, input) =>
          save(userId, input).pipe(Effect.catchTag("AgentNotAvailable", Effect.die)),
        update: (userId, { agentId, expectedRevision, ...settings }) =>
          save(userId, settings, { agentId, expectedRevision }).pipe(Effect.asVoid),
        remove: (userId, agentId) =>
          db
            .delete(agents)
            .where(owned(userId, agentId))
            .returning({ id: agents.id })
            .pipe(
              Effect.map((rows) => rows.length > 0),
              Effect.orDie,
            ),
      });
    }),
  );
}
