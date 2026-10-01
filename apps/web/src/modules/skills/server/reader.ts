import { Context, Effect, Layer } from "effect";
import { BlobStore } from "~/modules/attachments/server/blob-store.ts";
import { findBuiltinSkill } from "../bundled/index.ts";
import { SkillNotAvailable } from "../errors.ts";

import type { SkillManifestEntry } from "../schema.ts";
import { decodeStoredFile, verifyStoredFile } from "./content-hash.ts";
import { SkillRepo } from "./repo.ts";

export type SkillFileRead =
  | { readonly kind: "text"; readonly content: string }
  | { readonly kind: "binary"; readonly mediaType: string; readonly size: number };

/** Private execution reader has no editor, import or mutation dependencies. */
export class SkillReader extends Context.Service<
  SkillReader,
  {
    authorize(userId: string, ids: readonly string[]): Effect.Effect<void, SkillNotAvailable>;
    /** Skills the reader can use but did not select, for model discovery. */
    catalogue(userId: string, exclude: readonly string[]): Effect.Effect<SkillManifestEntry[]>;
    /** Text as text; a binary file is described, its bytes left unread. */
    readPinned(
      userId: string,
      entry: SkillManifestEntry,
      path: string,
    ): Effect.Effect<SkillFileRead | null, SkillNotAvailable>;
    canReadRevision(userId: string, revisionId: string): Effect.Effect<boolean>;
    /** A pinned revision's files, described: for picking out assets such as fonts. */
    listFiles(
      userId: string,
      entry: SkillManifestEntry,
    ): Effect.Effect<
      ReadonlyArray<{ path: string; mediaType: string | null; size: number }>,
      SkillNotAvailable
    >;
    /** A file's stored bytes, for a tool that opens it. */
    readPinnedBytes(
      userId: string,
      entry: SkillManifestEntry,
      path: string,
    ): Effect.Effect<{ bytes: Uint8Array; mediaType: string } | null, SkillNotAvailable>;
  }
>()("chat/skills/SkillReader") {
  static readonly layer = Layer.effect(
    SkillReader,
    Effect.gen(function* () {
      const repo = yield* SkillRepo;
      const blobs = yield* BlobStore;
      return SkillReader.of({
        authorize: repo.authorize,
        canReadRevision: repo.canReadRevision,
        listFiles: Effect.fn("SkillReader.listFiles")(function* (userId, entry) {
          if (findBuiltinSkill(entry.skillId)) return [];
          return (yield* repo.files(userId, entry)).map(({ path, mediaType, size }) => ({
            path,
            mediaType,
            size,
          }));
        }),
        catalogue: repo.catalogue,
        readPinned: Effect.fn("SkillReader.readPinned")(function* (userId, entry, path) {
          // Builtins are single-file: only the root exists and nothing hits
          // the database or blob store.
          const builtin = findBuiltinSkill(entry.skillId);
          if (builtin)
            return path === "SKILL.md" ? { kind: "text" as const, content: builtin.root } : null;
          const files = yield* repo.files(userId, entry);
          const file = files.find((file) => file.path === path);
          if (!file) return null;
          if (file.mediaType !== null) {
            yield* repo.authorize(userId, [entry.skillId]);
            return { kind: "binary" as const, mediaType: file.mediaType, size: file.size };
          }
          const bytes = yield* blobs.get(file.storageKey).pipe(Effect.orDie);
          const content = decodeStoredFile(bytes, file);
          yield* repo.authorize(userId, [entry.skillId]);
          return { kind: "text" as const, content };
        }),
        readPinnedBytes: Effect.fn("SkillReader.readPinnedBytes")(function* (userId, entry, path) {
          if (findBuiltinSkill(entry.skillId)) return null;
          const file = (yield* repo.files(userId, entry)).find(
            (candidate) => candidate.path === path,
          );
          if (!file) return null;
          const bytes = verifyStoredFile(
            yield* blobs.get(file.storageKey).pipe(Effect.orDie),
            file,
          );
          yield* repo.authorize(userId, [entry.skillId]);
          return { bytes, mediaType: file.mediaType ?? "text/plain" };
        }),
      });
    }),
  ).pipe(Layer.provideMerge(SkillRepo.layer));
}
