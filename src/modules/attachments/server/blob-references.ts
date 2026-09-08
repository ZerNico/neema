import { and, asc, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";
import {
  attachmentBlobs,
  attachments,
  blobCleanupIntents,
  knowledgeDocumentVersions,
  skillFiles,
} from "~/db/schema/index.ts";
import type { DbTx } from "./repo.ts";

// Every reference writer/remover takes these locks before changing references.
// Sorting gives multi-blob operations one lock order. Check for orphans in a
// subsequent statement so a waiter sees references committed by the lock holder.
export const lockBlobs = (tx: DbTx, ids: ReadonlyArray<string>) =>
  ids.length === 0
    ? Effect.succeed([])
    : tx
        .select()
        .from(attachmentBlobs)
        .where(inArray(attachmentBlobs.id, [...new Set(ids)]))
        .orderBy(asc(attachmentBlobs.id))
        .for("update");

/**
 * Call with locked blob rows, after removing references; delete bytes after
 * commit.
 *
 * The returned keys are also recorded as durable deletion intents in the same
 * transaction: the caller's post-commit delete is an optimization, and a crash
 * before it runs leaves the reconciler to finish the job rather than leaking
 * the object forever.
 */
export const collectOrphanedBlobs = (tx: DbTx, ids: ReadonlyArray<string>) =>
  ids.length === 0
    ? Effect.succeed([] as string[])
    : tx
        .delete(attachmentBlobs)
        .where(
          and(
            inArray(attachmentBlobs.id, [...ids]),
            sql`not exists (select 1 from ${attachments} where ${attachments.blobId} = ${attachmentBlobs.id})`,
            sql`not exists (select 1 from ${knowledgeDocumentVersions} where ${knowledgeDocumentVersions.blobId} = ${attachmentBlobs.id})`,
            sql`not exists (select 1 from ${skillFiles} where ${skillFiles.blobId} = ${attachmentBlobs.id})`,
          ),
        )
        .returning({ storageKey: attachmentBlobs.storageKey })
        .pipe(
          Effect.map((rows) => rows.map((row) => row.storageKey)),
          Effect.tap((keys) =>
            keys.length === 0
              ? Effect.void
              : tx
                  .insert(blobCleanupIntents)
                  .values(keys.map((storageKey) => ({ storageKey, kind: "orphan" as const })))
                  // A key reincarnated and orphaned again keeps one pending
                  // decision; the reconciler re-checks ownership regardless.
                  .onConflictDoUpdate({
                    target: blobCleanupIntents.storageKey,
                    set: { kind: "orphan", attempts: 0, notBefore: new Date() },
                  }),
          ),
        );
