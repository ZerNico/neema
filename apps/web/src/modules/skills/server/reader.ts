import { Context, Effect, Layer } from "effect";
import { BlobStore } from "~/modules/attachments/server/blob-store.ts";
import { findBuiltinSkill } from "../bundled/index.ts";
import { SkillNotAvailable } from "../errors.ts";

import type { SkillManifestEntry } from "../schema.ts";
import { decodeStoredFile } from "./content-hash.ts";
import { SkillRepo } from "./repo.ts";

/** Private execution reader has no editor, import or mutation dependencies. */
export class SkillReader extends Context.Service<
  SkillReader,
  {
    authorize(userId: string, ids: readonly string[]): Effect.Effect<void, SkillNotAvailable>;
    /** Skills the reader can use but did not select, for model discovery. */
    catalogue(userId: string, exclude: readonly string[]): Effect.Effect<SkillManifestEntry[]>;
    readPinned(
      userId: string,
      entry: SkillManifestEntry,
      path: string,
    ): Effect.Effect<string | null, SkillNotAvailable>;
  }
>()("chat/skills/SkillReader") {
  static readonly layer = Layer.effect(
    SkillReader,
    Effect.gen(function* () {
      const repo = yield* SkillRepo;
      const blobs = yield* BlobStore;
      return SkillReader.of({
        authorize: repo.authorize,
        catalogue: repo.catalogue,
        readPinned: Effect.fn("SkillReader.readPinned")(function* (userId, entry, path) {
          // Builtins are single-file: only the root exists and nothing hits
          // the database or blob store.
          const builtin = findBuiltinSkill(entry.skillId);
          if (builtin) return path === "SKILL.md" ? builtin.root : null;
          const files = yield* repo.files(userId, entry);
          const file = files.find((file) => file.path === path);
          if (!file) return null;
          const bytes = yield* blobs.get(file.storageKey).pipe(Effect.orDie);
          const content = decodeStoredFile(bytes, file);
          yield* repo.authorize(userId, [entry.skillId]);
          return content;
        }),
      });
    }),
  ).pipe(Layer.provideMerge(SkillRepo.layer));
}
