import { Cause, Context, Effect } from "effect";
import type { DbTx } from "~/modules/attachments/server/repo.ts";

/** Internal request-local write fence, evaluated inside the memory transaction before other locks. */
export const MemorySaveGuard = Context.Reference<(tx: DbTx) => Effect.Effect<void>>(
  "memory/MemorySaveGuard",
  { defaultValue: () => () => Effect.void },
);

/** Guard failures are terminal, unlike recoverable ordinary memory persistence defects. */
export class MemorySaveGuardFailure extends Error {
  constructor(cause: Cause.Cause<never>) {
    super("Memory save ownership guard failed", { cause });
    this.name = "MemorySaveGuardFailure";
  }
}

export const isMemorySaveGuardFailure = (cause: Cause.Cause<unknown>) =>
  cause.reasons.some(
    (reason) => Cause.isDieReason(reason) && reason.defect instanceof MemorySaveGuardFailure,
  );
