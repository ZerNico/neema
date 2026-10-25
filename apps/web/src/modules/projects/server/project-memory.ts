import { and, asc, eq, ne, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { uuidv7 } from "uuidv7";
import { projectMemories, user } from "~/db/schema/index.ts";
import { GenerationFence, lockGeneration } from "~/modules/chat/server/generation-fence.ts";
import { prepareMemoryContent } from "~/modules/memory/server/service.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db, type DbTx } from "~/server/db.ts";
import { ProjectNotAvailable, ProjectRejected } from "../errors.ts";
import {
  PROJECT_MEMORY_LIMITS,
  projectCan,
  type ProjectMemory,
  type ProjectRole,
} from "../schema.ts";
import { projectAudience, projectRole } from "./access.ts";

type ProjectMemoryError = ProjectNotAvailable | ProjectRejected;
export type ProjectMemorySave =
  | { outcome: "created" | "unchanged" }
  | {
      outcome: "rejected";
      reason: "empty" | "too_long" | "sensitive" | "limit_reached" | "read_only";
    };

const prepare = (content: string) => prepareMemoryContent(content, PROJECT_MEMORY_LIMITS.content);
const rejectionText = {
  empty: "A project memory cannot be empty.",
  too_long: `A project memory can be at most ${PROJECT_MEMORY_LIMITS.content} characters.`,
  sensitive: "That looks like a secret or personal identifier, which a project should not keep.",
} as const;

/** Serializes saves per project, so the cap holds under concurrent writers. */
const lockProject = (tx: DbTx, projectId: string) =>
  tx
    .execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`project-memory:${projectId}`}, 0))`,
    )
    .pipe(Effect.orDie);
const toMemory = (row: typeof projectMemories.$inferSelect & { createdByName: string | null }) => ({
  id: row.id,
  content: row.content,
  origin: row.origin,
  createdByName: row.createdByName,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
/** Inserts unless the same fact is already kept; caller holds the project lock. */
const insert = (
  tx: DbTx,
  values: {
    projectId: string;
    content: string;
    contentHash: string;
    origin: "manual" | "model";
    userId: string;
    sourceConversationId?: string;
  },
) =>
  Effect.gen(function* () {
    const [existing] = yield* tx
      .select({ id: projectMemories.id })
      .from(projectMemories)
      .where(
        and(
          eq(projectMemories.projectId, values.projectId),
          eq(projectMemories.contentHash, values.contentHash),
        ),
      )
      .pipe(Effect.orDie);
    if (existing) return { outcome: "unchanged" as const, id: existing.id };
    const [count] = yield* tx
      .select({ value: sql<number>`count(*)::int` })
      .from(projectMemories)
      .where(eq(projectMemories.projectId, values.projectId))
      .pipe(Effect.orDie);
    if ((count?.value ?? 0) >= PROJECT_MEMORY_LIMITS.perProject)
      return { outcome: "limit_reached" as const };
    const id = uuidv7();
    yield* tx
      .insert(projectMemories)
      .values({
        id,
        projectId: values.projectId,
        content: values.content,
        contentHash: values.contentHash,
        origin: values.origin,
        createdByUserId: values.userId,
        sourceConversationId: values.sourceConversationId ?? null,
      })
      .pipe(Effect.orDie);
    return { outcome: "created" as const, id };
  });

/**
 * Project memory: facts about the work, visible to every member's chats in
 * the project. It belongs to the project like its documents, so it follows
 * the project role alone, not the personal memory feature; changing it needs
 * an editor.
 */
export class ProjectMemoryService extends Context.Service<
  ProjectMemoryService,
  {
    list(
      userId: string,
      projectId: string,
    ): Effect.Effect<ReadonlyArray<ProjectMemory>, ProjectNotAvailable>;
    add(
      userId: string,
      projectId: string,
      content: string,
    ): Effect.Effect<ProjectMemory, ProjectMemoryError>;
    update(
      userId: string,
      projectId: string,
      memoryId: string,
      content: string,
    ): Effect.Effect<void, ProjectMemoryError>;
    remove(
      userId: string,
      projectId: string,
      memoryId: string,
    ): Effect.Effect<void, ProjectMemoryError>;
    /**
     * The model's save, under the generation's fence taken first inside the
     * transaction, exactly like a personal memory save.
     */
    saveModel(
      userId: string,
      input: { projectId: string; content: string; sourceConversationId: string },
    ): Effect.Effect<ProjectMemorySave>;
  }
>()("chat/projects/ProjectMemoryService") {
  static readonly layer = Layer.effect(
    ProjectMemoryService,
    Effect.gen(function* () {
      const db = yield* Db;
      const bus = yield* SyncBus;
      const transaction = <A, E, R>(body: (tx: DbTx) => Effect.Effect<A, E, R>) =>
        db.transaction(body).pipe(Effect.catchTag("SqlError", Effect.die));
      const access = (userId: string, projectId: string, tx?: DbTx) =>
        projectRole(tx ?? db, userId, projectId);
      const requireEditor = (tx: DbTx, userId: string, projectId: string) =>
        Effect.gen(function* () {
          const role = yield* access(userId, projectId, tx);
          if (!role) return yield* new ProjectNotAvailable({ projectId });
          if (!projectCan.edit(role))
            return yield* new ProjectRejected({ reason: "project memory is read-only for you" });
          return role;
        });
      const changed = (projectId: string) =>
        projectAudience(db, projectId).pipe(
          Effect.flatMap((members) =>
            Effect.forEach(
              members,
              (memberId) => bus.publish(memberId, { type: "project.changed", projectId }),
              { discard: true },
            ),
          ),
          Effect.catchCause(() => Effect.logWarning("project memory invalidation failed")),
        );
      const list = Effect.fn("ProjectMemoryService.list")(function* (
        userId: string,
        projectId: string,
      ) {
        if (!(yield* access(userId, projectId)))
          return yield* new ProjectNotAvailable({ projectId });
        const rows = yield* db
          .select({ memory: projectMemories, createdByName: user.name })
          .from(projectMemories)
          .leftJoin(user, eq(user.id, projectMemories.createdByUserId))
          .where(eq(projectMemories.projectId, projectId))
          .orderBy(asc(projectMemories.createdAt), asc(projectMemories.id))
          .pipe(Effect.orDie);
        return rows.map((row) => toMemory({ ...row.memory, createdByName: row.createdByName }));
      });

      return ProjectMemoryService.of({
        list,
        add: Effect.fn("ProjectMemoryService.add")(function* (userId, projectId, content) {
          const prepared = prepare(content);
          if (!prepared.ok)
            return yield* new ProjectRejected({ reason: rejectionText[prepared.reason] });
          const outcome = yield* transaction((tx) =>
            Effect.gen(function* () {
              yield* requireEditor(tx, userId, projectId);
              yield* lockProject(tx, projectId);
              return yield* insert(tx, { projectId, userId, origin: "manual", ...prepared });
            }),
          );
          if (outcome.outcome === "limit_reached")
            return yield* new ProjectRejected({ reason: "this project's memory is full" });
          yield* changed(projectId);
          const memories = yield* list(userId, projectId);
          return memories.find((memory) => memory.id === outcome.id)!;
        }),
        update: Effect.fn("ProjectMemoryService.update")(
          function* (userId, projectId, memoryId, content) {
            const prepared = prepare(content);
            if (!prepared.ok)
              return yield* new ProjectRejected({
                reason: rejectionText[prepared.reason],
              });
            yield* transaction((tx) =>
              Effect.gen(function* () {
                yield* requireEditor(tx, userId, projectId);
                yield* lockProject(tx, projectId);
                const [duplicate] = yield* tx
                  .select({ id: projectMemories.id })
                  .from(projectMemories)
                  .where(
                    and(
                      eq(projectMemories.projectId, projectId),
                      eq(projectMemories.contentHash, prepared.contentHash),
                      ne(projectMemories.id, memoryId),
                    ),
                  )
                  .pipe(Effect.orDie);
                if (duplicate)
                  return yield* new ProjectRejected({ reason: "the project already keeps that" });
                const rows = yield* tx
                  .update(projectMemories)
                  .set({
                    content: prepared.content,
                    contentHash: prepared.contentHash,
                    // Written by a person now, whoever wrote it first.
                    origin: "manual",
                    updatedAt: new Date(),
                  })
                  .where(
                    and(eq(projectMemories.id, memoryId), eq(projectMemories.projectId, projectId)),
                  )
                  .returning({ id: projectMemories.id })
                  .pipe(Effect.orDie);
                if (!rows.length)
                  return yield* new ProjectRejected({ reason: "that memory is gone" });
              }),
            );
            yield* changed(projectId);
          },
        ),
        remove: Effect.fn("ProjectMemoryService.remove")(function* (userId, projectId, memoryId) {
          yield* transaction((tx) =>
            Effect.gen(function* () {
              yield* requireEditor(tx, userId, projectId);
              yield* tx
                .delete(projectMemories)
                .where(
                  and(eq(projectMemories.id, memoryId), eq(projectMemories.projectId, projectId)),
                )
                .pipe(Effect.orDie);
            }),
          );
          yield* changed(projectId);
        }),
        saveModel: Effect.fn("ProjectMemoryService.saveModel")(function* (userId, input) {
          const prepared = prepare(input.content);
          if (!prepared.ok) return { outcome: "rejected" as const, reason: prepared.reason };
          const fence = yield* GenerationFence;
          const outcome = yield* transaction((tx) =>
            Effect.gen(function* () {
              if (fence) yield* lockGeneration(tx, fence);
              const role: ProjectRole | null = yield* access(userId, input.projectId, tx);
              if (!projectCan.edit(role)) return { outcome: "read_only" as const };
              yield* lockProject(tx, input.projectId);
              return yield* insert(tx, {
                projectId: input.projectId,
                userId,
                origin: "model",
                sourceConversationId: input.sourceConversationId,
                content: prepared.content,
                contentHash: prepared.contentHash,
              });
            }),
          );
          if (outcome.outcome === "read_only" || outcome.outcome === "limit_reached")
            return { outcome: "rejected" as const, reason: outcome.outcome };
          if (outcome.outcome === "created") yield* changed(input.projectId);
          return { outcome: outcome.outcome };
        }),
      });
    }),
  );
}
