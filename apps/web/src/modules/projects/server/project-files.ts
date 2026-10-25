import { localized } from "~/i18n/localized.ts";
import { m } from "~/paraglide/messages.js";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { Context, Duration, Effect, Layer, Schedule } from "effect";
import { uuidv7 } from "uuidv7";
import {
  attachmentBlobs,
  attachments,
  conversations,
  messageAttachments,
  messages,
  projectFileVersions,
  projectFiles,
  projects,
  user,
} from "~/db/schema/index.ts";
import { classifyFile, sanitizeFileName } from "~/modules/attachments/server/validation.ts";
import { collectOrphanedBlobs, lockBlobs } from "~/modules/attachments/server/blob-references.ts";
import { BlobStore } from "~/modules/attachments/server/blob-store.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db, type DbTx } from "~/server/db.ts";
import { ProjectFileConflict, ProjectNotAvailable, ProjectRejected } from "../errors.ts";
import {
  PROJECT_FILE_LIMITS,
  type ProjectFileList,
  type ProjectFileSummary,
  type ProjectFileVersion,
} from "../files.ts";
import { projectAccess, projectNotifier, projectRole, requireProject } from "./access.ts";
import { readImageSize } from "~/modules/attachments/image-header.ts";
import { currentAttachmentId } from "~/modules/chat/server/file-aliases.ts";
import { StorageQuota } from "~/modules/limits/server/storage.ts";

type ProjectFileError = ProjectNotAvailable | ProjectRejected | ProjectFileConflict;
/** Who is writing: a person, or the model inside one answer. */
export type FileWriter =
  | { origin: "user"; userId: string }
  | {
      origin: "model";
      userId: string;
      generationId: string;
      /** The answer's fence, taken first in the write's transaction. */
      guard: (tx: DbTx) => Effect.Effect<unknown>;
    };
const SWEEP_EVERY = Duration.hours(1);
const lockProject = (tx: DbTx, projectId: string) =>
  tx
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .for("update")
    .pipe(Effect.orDie);

const summaryOf = (row: {
  id: string;
  name: string;
  version: number;
  versionId: string;
  mediaType: string;
  size: number;
  updatedAt: Date;
  updatedBy: string | null;
  origin: "user" | "model";
  versionCount: number;
}): ProjectFileSummary => ({ ...row, updatedAt: row.updatedAt.toISOString() });

/**
 * Drops what retention no longer keeps. The current version of every file
 * and every pinned one always stay. Returns storage keys to delete.
 */
const prune = (tx: DbTx, projectId: string) =>
  Effect.gen(function* () {
    const ranked = yield* tx
      .select({
        id: projectFileVersions.id,
        blobId: projectFileVersions.blobId,
        pinned: projectFileVersions.pinned,
        rank: sql<number>`row_number() over (partition by ${projectFileVersions.fileId} order by ${projectFileVersions.number} desc)::int`,
        expired: sql<boolean>`${projectFileVersions.createdAt} < now() - make_interval(days => ${PROJECT_FILE_LIMITS.historyDays})`,
      })
      .from(projectFileVersions)
      .innerJoin(projectFiles, eq(projectFiles.id, projectFileVersions.fileId))
      .where(eq(projectFiles.projectId, projectId))
      .pipe(Effect.orDie);
    const prunable = (row: (typeof ranked)[number]) => row.rank > 1 && !row.pinned;
    const drop = new Set(
      ranked
        .filter(
          (row) => prunable(row) && (row.expired || row.rank > PROJECT_FILE_LIMITS.historyVersions),
        )
        .map((row) => row.id),
    );
    if (!drop.size) return [];
    const blobIds = ranked.filter((row) => drop.has(row.id)).map((row) => row.blobId);
    yield* lockBlobs(tx, blobIds).pipe(Effect.orDie);
    yield* tx
      .delete(projectFileVersions)
      .where(inArray(projectFileVersions.id, [...drop]))
      .pipe(Effect.orDie);
    return yield* collectOrphanedBlobs(tx, blobIds).pipe(Effect.orDie);
  });

/**
 * Working files shared in a project. Each write is a whole new version; the
 * current one is the highest number and is never pruned. Older unpinned
 * versions go after 30 days or past 25 per file. Bytes are registered under
 * the project owner, so they count to the owner's storage and share the
 * project's lifetime.
 */
export class ProjectFileService extends Context.Service<
  ProjectFileService,
  {
    list(userId: string, projectId: string): Effect.Effect<ProjectFileList, ProjectNotAvailable>;
    versions(
      userId: string,
      fileId: string,
    ): Effect.Effect<ReadonlyArray<ProjectFileVersion>, ProjectNotAvailable>;
    /**
     * A new file, or a new version of one when `fileId` is given. The version
     * the writer started from is checked, so a write never lands on top of
     * someone else's newer version unseen.
     */
    write(
      writer: FileWriter,
      input: {
        projectId: string;
        fileId?: string | undefined;
        name: string;
        bytes: Uint8Array;
        basedOnVersion?: number | undefined;
      },
    ): Effect.Effect<ProjectFileSummary, ProjectFileError>;
    /** A person's attachment from one of their chats, stored as a project file. */
    saveAttachment(
      writer: FileWriter,
      input: {
        projectId: string;
        /** The model names a chat file by id or name; the newest of a name wins. */
        attachment: { id: string } | { reference: string };
        /** Only this chat's attachments, when the model saves. */
        conversationId?: string | undefined;
        fileId?: string | undefined;
        name?: string | undefined;
        basedOnVersion?: number | undefined;
      },
    ): Effect.Effect<ProjectFileSummary, ProjectFileError>;
    restore(
      userId: string,
      versionId: string,
      basedOnVersion: number,
    ): Effect.Effect<ProjectFileSummary, ProjectFileError>;
    pin(
      userId: string,
      versionId: string,
      input: { pinned: boolean; label?: string | undefined },
    ): Effect.Effect<void, ProjectFileError>;
    remove(userId: string, fileId: string): Effect.Effect<void, ProjectFileError>;
    download(
      userId: string,
      versionId: string,
    ): Effect.Effect<{ bytes: Uint8Array; name: string; mediaType: string } | null>;
    /** `download` with the bytes left unread until asked for, and the content hash. */
    openVersion(
      userId: string,
      versionId: string,
    ): Effect.Effect<{
      name: string;
      mediaType: string;
      sha256: string;
      bytes: Effect.Effect<Uint8Array | null>;
    } | null>;
    /** Whether the person may still read this exact version, without loading it. */
    canRead(
      userId: string,
      projectId: string,
      target: { fileId: string; version: number },
    ): Effect.Effect<boolean>;
    /** The current version's bytes, for a tool that takes the file itself. */
    open(
      userId: string,
      projectId: string,
      target: { fileId?: string | undefined; name?: string | undefined },
    ): Effect.Effect<
      { file: ProjectFileSummary; bytes: Uint8Array; blobId: string },
      ProjectFileError
    >;
  }
>()("chat/projects/ProjectFileService") {
  static readonly layer = Layer.effect(
    ProjectFileService,
    Effect.gen(function* () {
      const db = yield* Db;
      const blobs = yield* BlobStore;
      const attachmentService = yield* AttachmentService;
      const storage = yield* StorageQuota;
      const bus = yield* SyncBus;
      const transaction = <A, E, R>(body: (tx: DbTx) => Effect.Effect<A, E, R>) =>
        db.transaction(body).pipe(Effect.catchTag("SqlError", Effect.die));

      const changed = projectNotifier(db, bus);
      const fileProject = (tx: DbTx | typeof db, fileId: string) =>
        tx
          .select({ projectId: projectFiles.projectId, name: projectFiles.name })
          .from(projectFiles)
          .where(eq(projectFiles.id, fileId))
          .pipe(
            Effect.orDie,
            Effect.map(([row]) => row ?? null),
          );

      const summaries = (reader: DbTx | typeof db, projectId: string, fileIds?: string[]) =>
        Effect.gen(function* () {
          const latest = sql`(select max(${projectFileVersions.number}) from ${projectFileVersions} where ${projectFileVersions.fileId} = ${projectFiles.id})`;
          const rows = yield* reader
            .select({
              id: projectFiles.id,
              name: projectFiles.name,
              version: projectFileVersions.number,
              versionId: projectFileVersions.id,
              mediaType: projectFileVersions.mediaType,
              size: projectFileVersions.size,
              updatedAt: projectFileVersions.createdAt,
              updatedBy: user.name,
              origin: projectFileVersions.origin,
              versionCount: sql<number>`(select count(*)::int from ${projectFileVersions} v where v.file_id = ${projectFiles.id})`,
            })
            .from(projectFiles)
            .innerJoin(
              projectFileVersions,
              and(
                eq(projectFileVersions.fileId, projectFiles.id),
                eq(projectFileVersions.number, latest),
              ),
            )
            .leftJoin(user, eq(user.id, projectFileVersions.createdByUserId))
            .where(
              and(
                eq(projectFiles.projectId, projectId),
                fileIds ? inArray(projectFiles.id, fileIds) : undefined,
              ),
            )
            .orderBy(asc(projectFiles.name))
            .pipe(Effect.orDie);
          return rows.map(summaryOf);
        });

      const admitWrite = (writer: FileWriter, projectId: string) =>
        transaction((tx) =>
          Effect.gen(function* () {
            if (writer.origin === "model") yield* writer.guard(tx);
            yield* requireProject(tx, writer.userId, projectId, "edit");
          }),
        );

      const writeVersion = Effect.fn("ProjectFileService.writeVersion")(function* (
        writer: FileWriter,
        input: {
          projectId: string;
          fileId?: string | undefined;
          name: string;
          bytes: Uint8Array;
          basedOnVersion?: number | undefined;
        },
      ) {
        if (input.bytes.length === 0)
          return yield* new ProjectRejected({ reason: localized(m.projects_error_file_empty) });
        if (input.bytes.length > PROJECT_FILE_LIMITS.fileBytes)
          return yield* new ProjectRejected({ reason: localized(m.projects_error_file_too_large) });
        yield* admitWrite(writer, input.projectId);
        const name = sanitizeFileName(input.name);
        // Any file is kept; its bytes decide only how it is read and served.
        const kind = classifyFile(name, "", input.bytes);
        const [project] = yield* db
          .select({ ownerId: projects.userId })
          .from(projects)
          .where(eq(projects.id, input.projectId))
          .pipe(Effect.orDie);
        if (!project) return yield* new ProjectNotAvailable({ projectId: input.projectId });
        // What a person adds costs the owner's quota; the model's saves are kept like its files.
        if (writer.origin === "user")
          yield* storage.admitFor(project.ownerId, writer.userId, [input.bytes]).pipe(
            Effect.catchTag("StorageFull", (full) =>
              Effect.fail(
                new ProjectRejected({
                  reason: full.reason,
                }),
              ),
            ),
          );
        const stored = yield* attachmentService.storeBlob(project.ownerId, input.bytes);
        const result = yield* transaction((tx) =>
          Effect.gen(function* () {
            // Blob ownership and version authorship take these FK locks on insert.
            // Take them before conversation/project locks, not behind account deletion.
            yield* tx
              .select({ id: user.id })
              .from(user)
              .where(inArray(user.id, [...new Set([project.ownerId, writer.userId])].toSorted()))
              .orderBy(asc(user.id))
              .for("key share")
              .pipe(Effect.orDie);
            // Conversation before project, the order every attempt takes them in.
            if (writer.origin === "model") yield* writer.guard(tx);
            // Serialize the project's versions and retention before registering any blobs.
            yield* requireProject(tx, writer.userId, input.projectId, "edit", "update");
            const [existingBlob] = yield* tx
              .select({ id: attachmentBlobs.id })
              .from(attachmentBlobs)
              .where(
                and(
                  eq(attachmentBlobs.userId, project.ownerId),
                  eq(attachmentBlobs.sha256, stored.sha256),
                ),
              )
              .pipe(Effect.orDie);
            const retained = yield* tx
              .select({ blobId: projectFileVersions.blobId })
              .from(projectFileVersions)
              .innerJoin(projectFiles, eq(projectFiles.id, projectFileVersions.fileId))
              .where(eq(projectFiles.projectId, input.projectId))
              .pipe(Effect.orDie);
            // Upsert locks the incoming blob too. Order it with retention's locks,
            // since different projects can replace each other's shared bytes.
            yield* lockBlobs(tx, [
              ...retained.map((row) => row.blobId),
              ...(existingBlob ? [existingBlob.id] : []),
            ]).pipe(Effect.orDie);
            const [blob] = yield* tx
              .insert(attachmentBlobs)
              .values({
                id: uuidv7(),
                userId: project.ownerId,
                sha256: stored.sha256,
                storageKey: stored.storageKey,
                size: input.bytes.length,
                mediaType: kind.mediaType,
                ...readImageSize(input.bytes, kind.mediaType),
              })
              .onConflictDoUpdate({
                target: [attachmentBlobs.userId, attachmentBlobs.sha256],
                set: { sha256: stored.sha256 },
              })
              .returning()
              .pipe(Effect.orDie);
            const unused = blob!.storageKey === stored.storageKey ? [] : [stored.storageKey];
            let fileId = input.fileId;
            if (fileId) {
              const [file] = yield* tx
                .select({ id: projectFiles.id, name: projectFiles.name })
                .from(projectFiles)
                .where(
                  and(eq(projectFiles.id, fileId), eq(projectFiles.projectId, input.projectId)),
                )
                .for("update")
                .pipe(Effect.orDie);
              if (!file)
                return yield* new ProjectRejected({
                  reason: localized(m.projects_error_file_gone),
                });
              // A version is classified by its name, so a new name is a new file:
              // taken, it would break the unique name; free, it would rename silently.
              if (file.name !== name)
                return yield* new ProjectRejected({
                  reason: localized(m.projects_error_version_keeps_name, { file: file.name, name }),
                });
            } else {
              const [existing] = yield* tx
                .select({ id: projectFiles.id })
                .from(projectFiles)
                .where(
                  and(eq(projectFiles.projectId, input.projectId), eq(projectFiles.name, name)),
                )
                .pipe(Effect.orDie);
              if (existing)
                return yield* new ProjectRejected({
                  reason: localized(m.projects_error_name_taken, { name }),
                });
              const [count] = yield* tx
                .select({ value: sql<number>`count(*)::int` })
                .from(projectFiles)
                .where(eq(projectFiles.projectId, input.projectId))
                .pipe(Effect.orDie);
              if ((count?.value ?? 0) >= PROJECT_FILE_LIMITS.filesPerProject)
                return yield* new ProjectRejected({
                  reason: localized(m.projects_error_files_full),
                });
              fileId = uuidv7();
              yield* tx
                .insert(projectFiles)
                .values({ id: fileId, projectId: input.projectId, name })
                .pipe(Effect.orDie);
            }
            const [last] = yield* tx
              .select({ number: projectFileVersions.number })
              .from(projectFileVersions)
              .where(eq(projectFileVersions.fileId, fileId))
              .orderBy(desc(projectFileVersions.number))
              .limit(1)
              .pipe(Effect.orDie);
            const current = last?.number ?? 0;
            if (input.basedOnVersion !== undefined && input.basedOnVersion !== current)
              return yield* new ProjectFileConflict({
                basedOnVersion: input.basedOnVersion,
                current,
              });
            // Published IDs always name the same bytes, including repeated model saves.
            yield* tx
              .insert(projectFileVersions)
              .values({
                id: uuidv7(),
                fileId,
                number: current + 1,
                blobId: blob!.id,
                size: blob!.size,
                mediaType: kind.mediaType,
                origin: writer.origin,
                createdByUserId: writer.userId,
                generationId: writer.origin === "model" ? writer.generationId : null,
              })
              .pipe(Effect.orDie);
            yield* tx
              .update(projectFiles)
              .set({ name, updatedAt: new Date() })
              .where(eq(projectFiles.id, fileId))
              .pipe(Effect.orDie);
            const pruned = yield* prune(tx, input.projectId);
            const [summary] = yield* summaries(tx, input.projectId, [fileId]);
            return { summary: summary!, discard: [...unused, ...pruned] };
          }),
        );
        // On failure the bytes stay a candidate, and the reconciler removes
        // them once it sees no row owns them.
        yield* attachmentService.settleBlobs([stored.storageKey], result.discard);
        yield* changed(input.projectId);
        return result.summary;
      });

      const blobBytes = (blobId: string) =>
        Effect.gen(function* () {
          const [blob] = yield* db
            .select({ storageKey: attachmentBlobs.storageKey })
            .from(attachmentBlobs)
            .where(eq(attachmentBlobs.id, blobId))
            .pipe(Effect.orDie);
          if (!blob) return null;
          return yield* blobs.get(blob.storageKey).pipe(Effect.orDie);
        });

      const versionRow = (versionId: string) =>
        db
          .select({
            version: projectFileVersions,
            projectId: projectFiles.projectId,
            name: projectFiles.name,
          })
          .from(projectFileVersions)
          .innerJoin(projectFiles, eq(projectFiles.id, projectFileVersions.fileId))
          .where(eq(projectFileVersions.id, versionId))
          .pipe(
            Effect.orDie,
            Effect.map(([row]) => row ?? null),
          );

      // Writes apply retention to their own project; this catches the ones
      // nobody writes to any more.
      yield* Effect.gen(function* () {
        const due = yield* db
          .selectDistinct({ projectId: projectFiles.projectId })
          .from(projectFileVersions)
          .innerJoin(projectFiles, eq(projectFiles.id, projectFileVersions.fileId))
          .where(
            sql`not ${projectFileVersions.pinned} and ${projectFileVersions.createdAt} < now() - make_interval(days => ${PROJECT_FILE_LIMITS.historyDays})`,
          )
          .pipe(Effect.orDie);
        for (const { projectId } of due) {
          const discard = yield* transaction((tx) =>
            lockProject(tx, projectId).pipe(Effect.andThen(prune(tx, projectId))),
          );
          yield* attachmentService.deleteBlobs(discard);
        }
      }).pipe(
        Effect.catchCause((cause) => Effect.logError("project file sweep failed", cause)),
        Effect.repeat(Schedule.spaced(SWEEP_EVERY)),
        Effect.forkScoped,
      );

      const openVersion = Effect.fn("ProjectFileService.openVersion")(function* (
        userId: string,
        versionId: string,
      ) {
        const row = yield* versionRow(versionId);
        if (!row || !(yield* projectRole(db, userId, row.projectId))) return null;
        const [blob] = yield* db
          .select({ sha256: attachmentBlobs.sha256 })
          .from(attachmentBlobs)
          .where(eq(attachmentBlobs.id, row.version.blobId))
          .pipe(Effect.orDie);
        if (!blob) return null;
        return {
          name: row.name,
          mediaType: row.version.mediaType,
          sha256: blob.sha256,
          bytes: blobBytes(row.version.blobId),
        };
      });

      const open = Effect.fn("ProjectFileService.open")(function* (
        userId: string,
        projectId: string,
        target: { fileId?: string | undefined; name?: string | undefined },
      ) {
        yield* projectAccess(db, userId, projectId);
        const file = (yield* summaries(db, projectId)).find((each) =>
          target.fileId ? each.id === target.fileId : each.name === target.name,
        );
        if (!file)
          return yield* new ProjectRejected({ reason: localized(m.projects_error_no_such_file) });
        const row = yield* versionRow(file.versionId);
        const bytes = row ? yield* blobBytes(row.version.blobId) : null;
        if (!row || !bytes)
          return yield* new ProjectRejected({ reason: localized(m.projects_error_no_such_file) });
        return { file, bytes, blobId: row.version.blobId };
      });
      return ProjectFileService.of({
        list: Effect.fn("ProjectFileService.list")(function* (userId, projectId) {
          yield* projectAccess(db, userId, projectId);
          const files = yield* summaries(db, projectId);
          // Each stored file once, as the owner's storage counts it: a restore reuses its bytes.
          const [used] = yield* db
            .select({ value: sql<number>`coalesce(sum(${attachmentBlobs.size}), 0)::bigint` })
            .from(attachmentBlobs)
            .where(
              inArray(
                attachmentBlobs.id,
                db
                  .select({ id: projectFileVersions.blobId })
                  .from(projectFileVersions)
                  .innerJoin(projectFiles, eq(projectFiles.id, projectFileVersions.fileId))
                  .where(eq(projectFiles.projectId, projectId)),
              ),
            )
            .pipe(Effect.orDie);
          return { files, usedBytes: Number(used?.value ?? 0) };
        }),
        versions: Effect.fn("ProjectFileService.versions")(function* (userId, fileId) {
          const file = yield* fileProject(db, fileId);
          if (!file) return yield* new ProjectNotAvailable({ projectId: fileId });
          yield* projectAccess(db, userId, file.projectId);
          const rows = yield* db
            .select({ version: projectFileVersions, createdBy: user.name })
            .from(projectFileVersions)
            .leftJoin(user, eq(user.id, projectFileVersions.createdByUserId))
            .where(eq(projectFileVersions.fileId, fileId))
            .orderBy(desc(projectFileVersions.number))
            .pipe(Effect.orDie);
          return rows.map(({ version, createdBy }, index) => ({
            id: version.id,
            number: version.number,
            size: version.size,
            mediaType: version.mediaType,
            origin: version.origin,
            createdBy,
            pinned: version.pinned,
            label: version.label,
            createdAt: version.createdAt.toISOString(),
            current: index === 0,
          }));
        }),
        write: writeVersion,
        saveAttachment: Effect.fn("ProjectFileService.saveAttachment")(function* (writer, input) {
          yield* admitWrite(writer, input.projectId);
          const requested =
            "id" in input.attachment ? input.attachment.id : input.attachment.reference;
          const resolved = input.conversationId
            ? yield* currentAttachmentId(
                db,
                { userId: writer.userId, conversationId: input.conversationId },
                requested,
              )
            : requested;
          const [attachment] = yield* db
            .select({ blobId: attachments.blobId, fileName: attachments.fileName })
            .from(attachments)
            .where(
              and(
                "id" in input.attachment
                  ? eq(attachments.id, resolved)
                  : or(eq(attachments.id, resolved), eq(attachments.fileName, resolved)),
                eq(attachments.userId, writer.userId),
                // The model may only move files from its own chat.
                input.conversationId
                  ? sql`exists (select 1 from ${messageAttachments} join ${messages} on ${messages.id} = ${messageAttachments.messageId} join ${conversations} on ${conversations.id} = ${messages.conversationId} where ${messageAttachments.attachmentId} = ${attachments.id} and ${messageAttachments.kind} = 'file' and ${conversations.id} = ${input.conversationId})`
                  : undefined,
              ),
            )
            .orderBy(desc(attachments.createdAt))
            .limit(1)
            .pipe(Effect.orDie);
          if (!attachment)
            return yield* new ProjectRejected({
              reason: localized(m.projects_error_attachment_unavailable),
            });
          const bytes = yield* blobBytes(attachment.blobId);
          if (!bytes)
            return yield* new ProjectRejected({
              reason: localized(m.projects_error_attachment_unavailable),
            });
          // A new version keeps its file's name unless one is given, as an upload does.
          const [target] = input.fileId
            ? yield* db
                .select({ name: projectFiles.name })
                .from(projectFiles)
                .where(
                  and(
                    eq(projectFiles.id, input.fileId),
                    eq(projectFiles.projectId, input.projectId),
                  ),
                )
                .pipe(Effect.orDie)
            : [];
          return yield* writeVersion(writer, {
            projectId: input.projectId,
            fileId: input.fileId,
            name: input.name ?? target?.name ?? attachment.fileName,
            bytes,
            basedOnVersion: input.basedOnVersion,
          });
        }),
        restore: Effect.fn("ProjectFileService.restore")(
          function* (userId, versionId, basedOnVersion) {
            const row = yield* versionRow(versionId);
            if (!row)
              return yield* new ProjectRejected({
                reason: localized(m.projects_error_version_gone),
              });
            yield* admitWrite({ origin: "user", userId }, row.projectId);
            const bytes = yield* blobBytes(row.version.blobId);
            if (!bytes)
              return yield* new ProjectRejected({
                reason: localized(m.projects_error_version_gone),
              });
            // A restore is a new version like any other, so history stays in order.
            return yield* writeVersion(
              { origin: "user", userId },
              {
                projectId: row.projectId,
                fileId: row.version.fileId,
                name: row.name,
                bytes,
                basedOnVersion,
              },
            );
          },
        ),
        pin: Effect.fn("ProjectFileService.pin")(function* (userId, versionId, input) {
          const row = yield* versionRow(versionId);
          if (!row)
            return yield* new ProjectRejected({ reason: localized(m.projects_error_version_gone) });
          yield* transaction((tx) =>
            Effect.gen(function* () {
              yield* requireProject(tx, userId, row.projectId, "edit", "update");
              const [current] = yield* tx
                .select({ pinned: projectFileVersions.pinned })
                .from(projectFileVersions)
                .where(eq(projectFileVersions.id, versionId))
                .pipe(Effect.orDie);
              if (!current)
                return yield* new ProjectRejected({
                  reason: localized(m.projects_error_version_gone),
                });
              if (input.pinned && !current.pinned) {
                const [count] = yield* tx
                  .select({ value: sql<number>`count(*)::int` })
                  .from(projectFileVersions)
                  .where(
                    and(
                      eq(projectFileVersions.fileId, row.version.fileId),
                      eq(projectFileVersions.pinned, true),
                    ),
                  )
                  .pipe(Effect.orDie);
                if ((count?.value ?? 0) >= PROJECT_FILE_LIMITS.pinsPerFile)
                  return yield* new ProjectRejected({
                    reason: localized(m.projects_error_pins_full, {
                      max: PROJECT_FILE_LIMITS.pinsPerFile,
                    }),
                  });
              }
              yield* tx
                .update(projectFileVersions)
                .set({
                  pinned: input.pinned,
                  label: input.pinned ? input.label?.trim() || null : null,
                })
                .where(eq(projectFileVersions.id, versionId))
                .pipe(Effect.orDie);
            }),
          );
          yield* changed(row.projectId);
        }),
        remove: Effect.fn("ProjectFileService.remove")(function* (userId, fileId) {
          const file = yield* fileProject(db, fileId);
          if (!file) return;
          const discard = yield* transaction((tx) =>
            Effect.gen(function* () {
              yield* requireProject(tx, userId, file.projectId, "edit", "update");
              const versions = yield* tx
                .select({ blobId: projectFileVersions.blobId })
                .from(projectFileVersions)
                .where(eq(projectFileVersions.fileId, fileId))
                .pipe(Effect.orDie);
              const blobIds = versions.map((version) => version.blobId);
              yield* lockBlobs(tx, blobIds).pipe(Effect.orDie);
              yield* tx.delete(projectFiles).where(eq(projectFiles.id, fileId)).pipe(Effect.orDie);
              return yield* collectOrphanedBlobs(tx, blobIds).pipe(Effect.orDie);
            }),
          );
          yield* attachmentService.deleteBlobs(discard);
          yield* changed(file.projectId);
        }),
        download: Effect.fn("ProjectFileService.download")(function* (userId, versionId) {
          const file = yield* openVersion(userId, versionId);
          const bytes = file ? yield* file.bytes : null;
          return file && bytes ? { bytes, name: file.name, mediaType: file.mediaType } : null;
        }),
        openVersion,
        open,
        canRead: Effect.fn("ProjectFileService.canRead")(function* (userId, projectId, target) {
          if (!(yield* projectRole(db, userId, projectId))) return false;
          const [row] = yield* db
            .select({ id: projectFileVersions.id })
            .from(projectFileVersions)
            .innerJoin(projectFiles, eq(projectFiles.id, projectFileVersions.fileId))
            .where(
              and(
                eq(projectFiles.projectId, projectId),
                eq(projectFileVersions.fileId, target.fileId),
                eq(projectFileVersions.number, target.version),
              ),
            )
            .limit(1)
            .pipe(Effect.orDie);
          return row !== undefined;
        }),
      });
    }),
  );
}
