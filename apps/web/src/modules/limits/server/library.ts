import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import {
  attachmentBlobs,
  attachments,
  conversationQueueEntries,
  conversationQueueEntryAttachments,
  conversations,
  conversationWorkingFiles,
  documentImages,
  documents,
  knowledgeCollections,
  knowledgeDocuments,
  knowledgeDocumentVersions,
  messageAttachments,
  messages,
  projectFiles,
  projectFileVersions,
  projects,
  skillFiles,
  skillRevisions,
  skills,
} from "~/db/schema/index.ts";
import { Db } from "~/server/db.ts";
import { LIBRARY_LISTED } from "../rules.ts";

/** Where one stored file is used, and what removing it there would mean. */
export type LibraryPlace =
  | {
      readonly kind: "chat";
      readonly attachmentId: string;
      readonly name: string;
      readonly conversationId: string;
      readonly title: string | null;
      /** In a chat waiting to be purged: it goes with the chat. */
      readonly deleted: boolean;
      /** A file the person sent, which they may take out; an answer's, queued or working one not. */
      readonly removable: boolean;
    }
  | { readonly kind: "upload"; readonly attachmentId: string; readonly name: string }
  | {
      readonly kind: "document";
      readonly attachmentId: string;
      readonly name: string;
      readonly documentId: string;
      readonly title: string;
      readonly projectId: string | null;
      readonly conversationId: string | null;
    }
  | {
      readonly kind: "project";
      readonly name: string;
      readonly projectId: string;
      readonly projectName: string;
      readonly versions: number;
    }
  | {
      readonly kind: "knowledge";
      readonly name: string;
      readonly collectionId: string;
      readonly collectionName: string;
    }
  | {
      readonly kind: "skill";
      readonly name: string;
      readonly skillId: string;
      readonly skillName: string;
    };

export interface LibraryFile {
  readonly blobId: string;
  readonly size: number;
  readonly mediaType: string;
  readonly createdAt: string;
  readonly places: ReadonlyArray<LibraryPlace>;
}

/**
 * Every file a person stores, largest first, each with every place it is used.
 * Bytes are counted once per file, so a file in three chats is one row with
 * three places. See `docs/internals/limits.md`.
 */
export class StorageLibrary extends Context.Service<
  StorageLibrary,
  {
    list(userId: string): Effect.Effect<{ files: LibraryFile[] }>;
  }
>()("chat/limits/StorageLibrary") {
  static readonly layer = Layer.effect(
    StorageLibrary,
    Effect.gen(function* () {
      const db = yield* Db;
      return StorageLibrary.of({
        list: Effect.fn("StorageLibrary.list")(function* (userId: string) {
          const blobs = yield* db
            .select({
              id: attachmentBlobs.id,
              size: attachmentBlobs.size,
              mediaType: attachmentBlobs.mediaType,
              createdAt: attachmentBlobs.createdAt,
            })
            .from(attachmentBlobs)
            .where(eq(attachmentBlobs.userId, userId))
            .orderBy(desc(attachmentBlobs.size), desc(attachmentBlobs.createdAt))
            .limit(LIBRARY_LISTED)
            .pipe(Effect.orDie);
          const ids = blobs.map((blob) => blob.id);
          const places = new Map<string, LibraryPlace[]>(ids.map((id) => [id, []]));
          const add = (blobId: string, place: LibraryPlace) => places.get(blobId)?.push(place);
          if (ids.length) {
            const files = yield* db
              .select({
                blobId: attachments.blobId,
                attachmentId: attachments.id,
                name: attachments.fileName,
                message: messages.conversationId,
                role: messages.role,
                linkKind: messageAttachments.kind,
                queued: conversationQueueEntries.conversationId,
                working: conversationWorkingFiles.conversationId,
                documentId: documents.id,
                documentTitle: documents.title,
                documentProject: documents.projectId,
                documentConversation: documents.conversationId,
              })
              .from(attachments)
              .leftJoin(messageAttachments, eq(messageAttachments.attachmentId, attachments.id))
              .leftJoin(messages, eq(messages.id, messageAttachments.messageId))
              .leftJoin(
                conversationQueueEntryAttachments,
                eq(conversationQueueEntryAttachments.attachmentId, attachments.id),
              )
              .leftJoin(
                conversationQueueEntries,
                eq(conversationQueueEntries.id, conversationQueueEntryAttachments.queueEntryId),
              )
              .leftJoin(
                conversationWorkingFiles,
                eq(conversationWorkingFiles.attachmentId, attachments.id),
              )
              .leftJoin(documentImages, eq(documentImages.attachmentId, attachments.id))
              .leftJoin(documents, eq(documents.id, documentImages.documentId))
              .where(and(inArray(attachments.blobId, ids), eq(attachments.userId, userId)))
              .pipe(Effect.orDie);
            const chatIds = [
              ...new Set(
                files.flatMap((file) => file.message ?? file.queued ?? file.working ?? []),
              ),
            ];
            const chats = chatIds.length
              ? yield* db
                  .select({
                    id: conversations.id,
                    title: conversations.title,
                    deletedAt: conversations.deletedAt,
                  })
                  .from(conversations)
                  .where(and(inArray(conversations.id, chatIds), eq(conversations.userId, userId)))
                  .pipe(Effect.orDie)
              : [];
            const chatOf = new Map(chats.map((chat) => [chat.id, chat]));
            for (const file of files) {
              const conversationId = file.message ?? file.queued ?? file.working;
              const chat = conversationId ? chatOf.get(conversationId) : undefined;
              if (file.documentId)
                add(file.blobId, {
                  kind: "document",
                  attachmentId: file.attachmentId,
                  name: file.name,
                  documentId: file.documentId,
                  title: file.documentTitle ?? "",
                  projectId: file.documentProject,
                  conversationId: file.documentConversation,
                });
              else if (chat)
                add(file.blobId, {
                  kind: "chat",
                  attachmentId: file.attachmentId,
                  name: file.name,
                  conversationId: chat.id,
                  title: chat.title,
                  deleted: chat.deletedAt !== null,
                  // Only what the person sent: an answer keeps its own files in its output too,
                  // and a queued or working file belongs to what is still under way.
                  removable:
                    file.message !== null &&
                    file.role === "user" &&
                    file.linkKind === "file" &&
                    chat.deletedAt === null,
                });
              else if (!conversationId)
                add(file.blobId, {
                  kind: "upload",
                  attachmentId: file.attachmentId,
                  name: file.name,
                });
            }
            const versions = yield* db
              .select({
                blobId: projectFileVersions.blobId,
                name: projectFiles.name,
                projectId: projects.id,
                projectName: projects.name,
                versions: sql<number>`count(*)::int`,
              })
              .from(projectFileVersions)
              .innerJoin(projectFiles, eq(projectFiles.id, projectFileVersions.fileId))
              .innerJoin(projects, eq(projects.id, projectFiles.projectId))
              .where(inArray(projectFileVersions.blobId, ids))
              .groupBy(projectFileVersions.blobId, projectFiles.name, projects.id, projects.name)
              .pipe(Effect.orDie);
            for (const row of versions)
              add(row.blobId, {
                kind: "project",
                name: row.name,
                projectId: row.projectId,
                projectName: row.projectName,
                versions: row.versions,
              });
            const knowledge = yield* db
              .selectDistinct({
                blobId: knowledgeDocumentVersions.blobId,
                name: knowledgeDocuments.title,
                collectionId: knowledgeCollections.id,
                collectionName: knowledgeCollections.name,
              })
              .from(knowledgeDocumentVersions)
              .innerJoin(
                knowledgeDocuments,
                eq(knowledgeDocuments.id, knowledgeDocumentVersions.documentId),
              )
              .innerJoin(
                knowledgeCollections,
                eq(knowledgeCollections.id, knowledgeDocuments.collectionId),
              )
              .where(
                and(
                  isNotNull(knowledgeDocumentVersions.blobId),
                  inArray(knowledgeDocumentVersions.blobId, ids),
                ),
              )
              .pipe(Effect.orDie);
            for (const row of knowledge)
              if (row.blobId)
                add(row.blobId, {
                  kind: "knowledge",
                  name: row.name,
                  collectionId: row.collectionId,
                  collectionName: row.collectionName,
                });
            const skillRows = yield* db
              .selectDistinct({
                blobId: skillFiles.blobId,
                name: skillFiles.path,
                skillId: skills.id,
                skillName: skills.name,
              })
              .from(skillFiles)
              .innerJoin(skillRevisions, eq(skillRevisions.id, skillFiles.revisionId))
              .innerJoin(skills, eq(skills.id, skillRevisions.skillId))
              .where(inArray(skillFiles.blobId, ids))
              .pipe(Effect.orDie);
            for (const row of skillRows)
              add(row.blobId, {
                kind: "skill",
                name: row.name,
                skillId: row.skillId,
                skillName: row.skillName,
              });
          }
          return {
            files: blobs.map((blob) => ({
              blobId: blob.id,
              size: blob.size,
              mediaType: blob.mediaType,
              createdAt: blob.createdAt.toISOString(),
              places: places.get(blob.id) ?? [],
            })),
          };
        }),
      });
    }),
  );
}
