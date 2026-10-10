import { Effect, Semaphore } from "effect";
import { eq } from "drizzle-orm";
import { projects } from "~/db/schema/index.ts";
import type { DbTx } from "~/modules/attachments/server/repo.ts";
import { projectCan } from "~/modules/projects/schema.ts";
import { projectAudience, projectRole } from "~/modules/projects/server/access.ts";
import type { SyncBus } from "~/modules/sync/server/bus.ts";
import type { Db } from "~/server/db.ts";
import { DocumentNotAvailable, DocumentRejected, type EditableDocument } from "../schema.ts";

/**
 * Runs every read-modify-write of one document alone, so a live entry in
 * memory and its rows move together. Text and sheets each keep their own.
 */
export function documentLocks() {
  const locks = new Map<string, { semaphore: Semaphore.Semaphore; holders: number }>();
  return (documentId: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const lock = locks.get(documentId) ?? { semaphore: Semaphore.makeUnsafe(1), holders: 0 };
          lock.holders++;
          locks.set(documentId, lock);
          return lock;
        }),
        (lock) => lock.semaphore.withPermits(1)(effect),
        (lock) =>
          Effect.sync(() => {
            if (--lock.holders === 0) locks.delete(documentId);
          }),
      );
}

/** Tells lists and cards a document changed: a chat's concerns its owner, a project's every member. */
export const notifyDocumentChanged =
  (db: Db["Service"], bus: SyncBus["Service"]) =>
  (userId: string, document: Pick<EditableDocument, "id" | "conversationId" | "projectId">) =>
    Effect.gen(function* () {
      const audience = document.projectId
        ? yield* projectAudience(db, document.projectId)
        : [userId];
      yield* Effect.forEach(
        audience,
        (memberId) =>
          bus.publish(memberId, {
            type: "document.changed",
            ...(document.conversationId
              ? { conversationId: document.conversationId }
              : { projectId: document.projectId! }),
            documentId: document.id,
          }),
        { discard: true },
      );
    }).pipe(Effect.catchCause(() => Effect.logWarning("document invalidation failed")));

/** Holds the project row against deletion while a document is added to it. */
export const lockProjectForEditing = (tx: DbTx, userId: string, projectId: string) =>
  Effect.gen(function* () {
    const [row] = yield* tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for("share")
      .pipe(Effect.orDie);
    const role = row ? yield* projectRole(tx, userId, projectId) : null;
    if (!role) return yield* new DocumentNotAvailable({ documentId: projectId });
    if (!projectCan.edit(role))
      return yield* new DocumentRejected({ reason: "this project is read-only for you" });
  });
