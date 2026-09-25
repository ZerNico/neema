import { and, desc, eq, or } from "drizzle-orm";
import { Effect, Option } from "effect";
import { attachmentBlobs, attachments, messageAttachments, messages } from "~/db/schema/index.ts";
import type { BlobStore } from "~/modules/attachments/server/blob-store.ts";
import type { ProjectFileService } from "~/modules/projects/server/project-files.ts";
import type { Db } from "~/server/db.ts";

/** Where a file a tool read came from, so the model can save a result back. */
export type ToolFileSource =
  | { readonly kind: "chat"; readonly attachmentId: string }
  | { readonly kind: "project"; readonly fileId: string; readonly version: number };

export interface ToolFile {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly source: ToolFileSource;
}

/**
 * Turns what the model passed for a file parameter into bytes, within what
 * the sender of this answer may read: files in this chat (attached or
 * produced), then the current version of a project file. An id matches
 * before a name; among equal names the newest chat file wins.
 */
export const makeToolFileResolver = (input: {
  db: Db["Service"];
  store: Pick<BlobStore["Service"], "get">;
  projectFiles: Option.Option<Pick<ProjectFileService["Service"], "open">>;
  userId: string;
  conversationId: string;
  projectId: string | null;
}) => {
  const chatFile = (reference: string) =>
    input.db
      .select({
        id: attachments.id,
        name: attachments.fileName,
        mediaType: attachmentBlobs.mediaType,
        storageKey: attachmentBlobs.storageKey,
      })
      .from(attachments)
      .innerJoin(attachmentBlobs, eq(attachmentBlobs.id, attachments.blobId))
      .innerJoin(messageAttachments, eq(messageAttachments.attachmentId, attachments.id))
      .innerJoin(messages, eq(messages.id, messageAttachments.messageId))
      .where(
        and(
          eq(messages.conversationId, input.conversationId),
          eq(attachments.userId, input.userId),
          or(eq(attachments.id, reference), eq(attachments.fileName, reference)),
        ),
      )
      // An exact id sorts first; then the newest file of that name.
      .orderBy(desc(eq(attachments.id, reference)), desc(attachments.createdAt))
      .limit(1)
      .pipe(
        Effect.orDie,
        Effect.map(([row]) => row ?? null),
      );

  return (reference: string): Effect.Effect<ToolFile, string> =>
    Effect.gen(function* () {
      const trimmed = reference.trim();
      if (!trimmed) return yield* Effect.fail("Pass a file id or name.");
      const found = yield* chatFile(trimmed);
      if (found) {
        const bytes = yield* input.store
          .get(found.storageKey)
          .pipe(Effect.mapError(() => `${found.name} could not be read.`));
        return {
          name: found.name,
          mediaType: found.mediaType,
          bytes,
          source: { kind: "chat", attachmentId: found.id },
        } satisfies ToolFile;
      }
      if (input.projectId && Option.isSome(input.projectFiles)) {
        const projectId = input.projectId;
        const opened = yield* Effect.firstSuccessOf([
          input.projectFiles.value.open(input.userId, projectId, { fileId: trimmed }),
          input.projectFiles.value.open(input.userId, projectId, { name: trimmed }),
        ]).pipe(Effect.option);
        if (Option.isSome(opened)) {
          const { file, bytes } = opened.value;
          return {
            name: file.name,
            mediaType: file.mediaType,
            bytes,
            source: { kind: "project", fileId: file.id, version: file.version },
          } satisfies ToolFile;
        }
      }
      return yield* Effect.fail(
        `No file ${JSON.stringify(trimmed)} in this chat${input.projectId ? " or its project" : ""}.`,
      );
    });
};
