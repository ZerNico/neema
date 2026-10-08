import { and, eq, isNull } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { scheduleRuns, schedules } from "~/db/schema/index.ts";
import { advertisedParameter, type ToolGroup } from "~/modules/tools/server/toolset.ts";
import type { Db } from "~/server/db.ts";
import { NOTIFY_MESSAGE_MAX, NotifyToolResult } from "../notify-schema.ts";

// Validated in the handler, like ask_user and save_memory: a malformed call
// comes back as a correction instead of failing the stream.
const Params = Schema.Struct({
  message: advertisedParameter({ type: "string", minLength: 1, maxLength: NOTIFY_MESSAGE_MAX }),
});

export const notifyUserTool = Tool.make("notify_user", {
  description:
    "This answer is a scheduled run, and its owner is told only if you call this. " +
    "Call it once, when the schedule's instructions say the result is worth telling them now; " +
    "do not call it to report that nothing changed. " +
    `message is the notification itself: plain text, one or two sentences, at most ${NOTIFY_MESSAGE_MAX} characters. ` +
    "It is sent when this answer ends.",
  parameters: Params,
  success: NotifyToolResult,
  failureMode: "return",
});

const fireOf = (attempt: { messageId: string; generationId: string }) =>
  and(
    eq(scheduleRuns.messageId, attempt.messageId),
    eq(scheduleRuns.generationId, attempt.generationId),
    isNull(scheduleRuns.settledAt),
  );

/**
 * The schedule run this attempt is, if a fire started it: nobody is there to
 * answer it. A retry, edit or resume is a new attempt, and the person's.
 */
export const findScheduleFire = Effect.fn("schedules.findScheduleFire")(function* (
  db: Db["Service"],
  attempt: { messageId: string; generationId: string },
) {
  const [run] = yield* db
    .select({ notify: schedules.notify })
    .from(scheduleRuns)
    .innerJoin(schedules, eq(schedules.id, scheduleRuns.scheduleId))
    .where(fireOf(attempt))
    .pipe(Effect.orDie);
  return run ?? null;
});

/**
 * Offered to a fire whose schedule notifies when the answer decides. The text
 * waits on the run row; settlement sends it once the answer ends, so a stopped
 * or replaced answer sends nothing.
 */
export function prepareNotifyTool(
  db: Db["Service"],
  attempt: { messageId: string; generationId: string },
) {
  let sent = false;
  const handler = (params: { readonly message?: unknown }) =>
    Effect.gen(function* (): Effect.fn.Return<NotifyToolResult> {
      const message = typeof params.message === "string" ? params.message.trim() : "";
      if (!message || message.length > NOTIFY_MESSAGE_MAX)
        return {
          v: 1,
          outcome: "rejected",
          message: `Send message as plain text of 1–${NOTIFY_MESSAGE_MAX} characters.`,
        };
      if (sent)
        return { v: 1, outcome: "rejected", message: "This answer already notified its owner." };
      const kept = yield* db
        .update(scheduleRuns)
        .set({ notifyMessage: message })
        .where(fireOf(attempt))
        .returning({ id: scheduleRuns.id })
        .pipe(Effect.orDie);
      if (kept.length === 0)
        return { v: 1, outcome: "rejected", message: "This answer can no longer notify." };
      sent = true;
      return { v: 1, outcome: "queued", message };
    });
  const group: ToolGroup = {
    toolkit: Toolkit.make(notifyUserTool),
    handlers: { notify_user: handler },
  };
  return { group };
}
