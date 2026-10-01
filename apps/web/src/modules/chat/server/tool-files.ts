import { and, desc, eq, or } from "drizzle-orm";
import { Effect, Option } from "effect";
import { attachmentBlobs, attachments, messageAttachments, messages } from "~/db/schema/index.ts";
import type { BlobStore } from "~/modules/attachments/server/blob-store.ts";
import type { ProjectFileService } from "~/modules/projects/server/project-files.ts";
import type { Db } from "~/server/db.ts";
import { currentAttachmentId } from "./file-aliases.ts";
import { parseFileRef, type FileRef } from "./file-ref.ts";
import type { WorkingFiles } from "./working-files.ts";
import type { SkillManifestEntry } from "~/modules/skills/schema.ts";
import type { SkillReader } from "~/modules/skills/server/reader.ts";

/** Where a file a tool read came from, so the model can save a result back. */
export type ToolFileSource =
  | { readonly kind: "chat"; readonly attachmentId: string }
  | { readonly kind: "project"; readonly fileId: string; readonly version: number }
  | { readonly kind: "working"; readonly workingFileId: string; readonly revision: number }
  | { readonly kind: "skill"; readonly revisionId: string; readonly path: string };

/** The skills this answer was offered, so a skill file resolves only at the revision it read. */
export interface ToolFileSkills {
  readonly entries: ReadonlyArray<SkillManifestEntry>;
  readonly reader: Pick<SkillReader["Service"], "readPinnedBytes" | "canReadRevision">;
}

export interface ToolFile {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly source: ToolFileSource;
  readonly ref: FileRef;
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
  projectFiles: Option.Option<Pick<ProjectFileService["Service"], "open" | "canRead">>;
  userId: string;
  conversationId: string;
  projectId: string | null;
  workspace?: WorkingFiles;
  skills?: ToolFileSkills;
}) => {
  const chat = { userId: input.userId, conversationId: input.conversationId };
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

  const resolve = (reference: string): Effect.Effect<ToolFile, string> =>
    Effect.gen(function* () {
      const trimmed = reference.trim();
      if (!trimmed) return yield* Effect.fail("Pass a file id or name.");
      const canonical = parseFileRef(trimmed);
      if (/^(attachment|project|working|skill):/.test(trimmed) && !canonical)
        return yield* Effect.fail("Invalid file reference.");
      if (canonical?.kind === "skill") {
        const entry = input.skills?.entries.find(
          (candidate) => candidate.revisionId === canonical.revisionId,
        );
        if (!entry || !input.skills)
          return yield* Effect.fail(
            "That skill file is not available in this answer; load the skill and read the file again for its current reference.",
          );
        const file = yield* input.skills.reader
          .readPinnedBytes(input.userId, entry, canonical.path)
          .pipe(Effect.orElseSucceed(() => null));
        if (!file) return yield* Effect.fail("No file at that path in the skill.");
        return {
          name: canonical.path.slice(canonical.path.lastIndexOf("/") + 1),
          mediaType: file.mediaType,
          bytes: file.bytes,
          source: { kind: "skill", revisionId: canonical.revisionId, path: canonical.path },
          ref: canonical,
        } satisfies ToolFile;
      }
      if (canonical?.kind === "working") {
        const workspace = input.workspace;
        if (!workspace) return yield* Effect.fail("This working file has expired.");
        const draft = yield* Effect.tryPromise({
          try: async () => {
            await workspace.load(canonical);
            return workspace.read(canonical);
          },
          catch: () => "This working file has expired or changed revision.",
        });
        return {
          name: draft.name,
          mediaType: draft.mediaType,
          bytes: draft.bytes,
          source: { kind: "working", workingFileId: canonical.id, revision: canonical.revision },
          ref: canonical,
        } satisfies ToolFile;
      }
      const currentId = yield* currentAttachmentId(
        input.db,
        chat,
        canonical?.kind === "attachment" ? canonical.id : trimmed,
      );
      const found = canonical?.kind === "project" ? null : yield* chatFile(currentId);
      if (found) {
        const bytes = yield* input.store
          .get(found.storageKey)
          .pipe(Effect.mapError(() => `${found.name} could not be read.`));
        return {
          name: found.name,
          mediaType: found.mediaType,
          bytes,
          source: { kind: "chat", attachmentId: found.id },
          ref: { kind: "attachment", id: found.id },
        } satisfies ToolFile;
      }
      if (canonical?.kind === "attachment")
        return yield* Effect.fail("That attachment is not available in this chat.");
      if (input.projectId && Option.isSome(input.projectFiles)) {
        const projectId = input.projectId;
        const opened = yield* (
          canonical?.kind === "project"
            ? input.projectFiles.value.open(input.userId, projectId, { fileId: canonical.id })
            : Effect.firstSuccessOf([
                input.projectFiles.value.open(input.userId, projectId, { fileId: trimmed }),
                input.projectFiles.value.open(input.userId, projectId, { name: trimmed }),
              ])
        ).pipe(Effect.option);
        if (Option.isSome(opened)) {
          const { file, bytes } = opened.value;
          if (canonical?.kind === "project" && canonical.version !== file.version)
            return yield* Effect.fail("The project file changed since that version was inspected.");
          return {
            name: file.name,
            mediaType: file.mediaType,
            bytes,
            source: { kind: "project", fileId: file.id, version: file.version },
            ref: { kind: "project", id: file.id, version: file.version },
          } satisfies ToolFile;
        }
      }
      return yield* Effect.fail(
        `No file ${JSON.stringify(trimmed)} in this chat${input.projectId ? " or its project" : ""}.`,
      );
    });

  /**
   * Whether the sender may still read the exact file a draft was opened from.
   * Metadata only: a project version stays readable after newer ones land,
   * and nothing is loaded just to ask.
   */
  const authorize = (reference: string): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const ref = parseFileRef(reference);
      switch (ref?.kind) {
        case "working":
          // Imports from the computer live only in this answer's workspace.
          return input.workspace !== undefined;
        case "attachment":
          return (
            (yield* chatFile(yield* currentAttachmentId(input.db, chat, ref.id)))?.id !== undefined
          );
        case "skill":
          // A draft keeps its own bytes; it only needs the skill still readable.
          return input.skills
            ? yield* input.skills.reader.canReadRevision(input.userId, ref.revisionId)
            : false;
        case "project":
          return input.projectId !== null && Option.isSome(input.projectFiles)
            ? yield* input.projectFiles.value.canRead(input.userId, input.projectId, {
                fileId: ref.id,
                version: ref.version,
              })
            : false;
        default:
          return false;
      }
    });

  return { resolve, authorize };
};

export type ToolFileResolver = ReturnType<typeof makeToolFileResolver>;
