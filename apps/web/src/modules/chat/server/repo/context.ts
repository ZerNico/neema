import { Effect } from "effect";
import { GenerationFence, lockGeneration } from "../generation-fence.ts";
import { createResearchStore } from "../research/repo.ts";
import { AttachmentRepo, type DbTx } from "~/modules/attachments/server/repo.ts";
import { Db } from "~/server/db.ts";

/** What every part of the chat repository is built from, made once per layer. */
export const makeRepoContext = Effect.gen(function* () {
  const db = yield* Db;
  const attachments = yield* AttachmentRepo;
  const research = createResearchStore(db);
  const generationWrite = <A, E, R>(run: (tx: DbTx) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const fence = yield* GenerationFence;
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            if (fence) yield* lockGeneration(tx, fence);
            return yield* run(tx);
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die));
    });
  return { db, attachments, research, generationWrite };
});

export type RepoContext = Effect.Success<typeof makeRepoContext>;
