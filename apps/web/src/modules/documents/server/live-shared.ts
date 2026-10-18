import { Effect, Semaphore } from "effect";
import { eq } from "drizzle-orm";
import { projects } from "~/db/schema/index.ts";
import { projectCan } from "~/modules/projects/schema.ts";
import { projectAudience, projectRole } from "~/modules/projects/server/access.ts";
import type { SyncBus } from "~/modules/sync/server/bus.ts";
import type { Db, DbTx } from "~/server/db.ts";
import { uuidv7 } from "uuidv7";
import {
  DOCUMENT_LIMITS,
  DocumentNotAvailable,
  DocumentRejected,
  type CommentInput,
  type DeleteCommentInput,
  type EditableDocument,
  type ResolveThreadInput,
} from "../schema.ts";
import type { DocumentRepo } from "./document-repo.ts";

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
  (
    userId: string,
    document: Pick<EditableDocument, "id" | "conversationId" | "projectId">,
    textOnly = false,
  ) =>
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
            ...(textOnly ? { textOnly: true as const } : {}),
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

type Repo = DocumentRepo["Service"];

/**
 * A person's comment, as rows: a reply, or a new thread under the ID the
 * client chose. True for a new thread. Caller holds the document's lock.
 */
export const personComment = (documents: Repo, userId: string, input: CommentInput) => (tx: DbTx) =>
  Effect.gen(function* () {
    const existing = yield* documents.comments(input.documentId, tx);
    if (existing.length >= DOCUMENT_LIMITS.comments)
      return yield* new DocumentRejected({ reason: "this document has too many comments" });
    const thread = existing.find((each) => each.id === input.threadId);
    if (thread && thread.threadId !== thread.id)
      return yield* new DocumentRejected({ reason: "reply to a thread's first comment" });
    // A new thread's ID is the client's; one taken elsewhere is refused, not a crash.
    const added = yield* documents.addComment(tx, {
      id: thread ? uuidv7() : input.threadId,
      documentId: input.documentId,
      threadId: input.threadId,
      userId,
      origin: "user",
      body: input.body,
      quote: thread ? null : (input.quote ?? null),
      toAssistant: input.toAssistant ?? false,
    });
    if (!added) return yield* new DocumentRejected({ reason: "that thread ID is taken" });
    return !thread;
  });

export const threadResolution = (documents: Repo, input: ResolveThreadInput) => (tx: DbTx) =>
  documents
    .resolveThread(tx, input.documentId, input.threadId, input.resolved)
    .pipe(
      Effect.flatMap((found) =>
        found ? Effect.void : Effect.fail(new DocumentRejected({ reason: "no such thread" })),
      ),
    );

export const commentDeletion =
  (documents: Repo, userId: string, input: DeleteCommentInput) => (tx: DbTx) =>
    documents
      .deleteComment(tx, input.documentId, input.commentId, userId)
      .pipe(
        Effect.flatMap((found) =>
          found
            ? Effect.void
            : Effect.fail(
                new DocumentRejected({ reason: "only your own or the assistant's comments" }),
              ),
        ),
      );
