import { Effect } from "effect";
import type { ResolveGeneration } from "~/modules/chat/server/repo.ts";
import { PLAIN_GENERATION } from "~/modules/chat/server/repo/generation-config.ts";

/**
 * A plain chat's attempt for tests that drive the repo directly: a retry keeps
 * the saved configuration, anything else starts from none. The service always
 * resolves for real; an agent or skill attempt needs it.
 */
export const plainResolve: ResolveGeneration = (_tx, _defaults, previous) =>
  Effect.succeed(previous ?? PLAIN_GENERATION);
