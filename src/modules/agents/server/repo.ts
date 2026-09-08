import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { uuidv7 } from "uuidv7";
import {
  agents,
  agentCollections,
  agentSkills,
  skills,
  knowledgeCollections,
  user,
} from "~/db/schema/index.ts";
import type { DbTx } from "~/modules/attachments/server/repo.ts";
import { agentReadable, collectionReadable } from "~/modules/knowledge/server/access.ts";
import { skillReadable } from "~/modules/skills/server/access.ts";
import { Db } from "~/server/db.ts";
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
}
const owned = (userId: string, agentId: string) =>
  and(eq(agents.id, agentId), eq(agents.userId, userId));
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
      const save = Effect.fn("AgentRepo.save")(function* (
        userId: string,
        input: AgentSettings,
        update?: { agentId: string; expectedRevision: number },
      ) {
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
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
                  .where(eq(user.id, userId))
                  .for("update");
                const [count] = yield* tx
                  .select({ value: sql<number>`count(*)::int` })
                  .from(agents)
                  .where(eq(agents.userId, userId));
                if (!owner || (count?.value ?? 0) >= AGENT_LIMITS.maxPerUser)
                  return yield* new AgentRejected({ reason: "agent limit reached" });
              }
              const { collectionIds, skillIds = [], ...settings } = input;
              if (skillIds.length) {
                const available = yield* tx
                  .select({ id: skills.id })
                  .from(skills)
                  .where(and(inArray(skills.id, [...skillIds]), skillReadable(userId)));
                if (available.length !== skillIds.length)
                  return yield* new AgentRejected({ reason: "a selected skill is unavailable" });
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
                  .values(
                    skillIds.map((skillId, position) => ({ agentId: id, skillId, position })),
                  );
              return id;
            }),
          )
          .pipe(
            Effect.catchTag("EffectDrizzleQueryError", Effect.die),
            Effect.catchTag("SqlError", Effect.die),
          );
      });
      return AgentRepo.of({
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
