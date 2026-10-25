import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { messageGenerationConfig } from "~/db/schema/index.ts";
import type { ResolveGeneration } from "~/modules/chat/server/repo.ts";
import { PLAIN_GENERATION } from "~/modules/chat/server/repo/generation-config.ts";
import { Db } from "~/server/db.ts";

/**
 * A plain chat's attempt for tests that drive the repo directly: a retry keeps
 * the saved configuration, anything else starts from none. The service always
 * resolves for real; an agent or skill attempt needs it.
 */
export const plainResolve: ResolveGeneration = (_tx, _defaults, previous) =>
  Effect.succeed(previous ?? PLAIN_GENERATION);

/** Turns search on or off in an answer's stored configuration, which the engine reads. */
export const setAttemptSearch = (messageId: string, searchEnabled: boolean) =>
  Effect.flatMap(Db, (db) =>
    db
      .update(messageGenerationConfig)
      .set({ searchEnabled })
      .where(eq(messageGenerationConfig.messageId, messageId))
      .pipe(Effect.orDie),
  );
