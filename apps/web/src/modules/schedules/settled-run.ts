import { answerExcerpt } from "~/modules/notifications/excerpt.ts";
import type { AppNotification } from "~/modules/notifications/schema.ts";
import type { NotificationEmail } from "~/modules/notifications/server/mail.ts";
import type { ScheduleNotify } from "./schema.ts";

/** A run the settlement claim saw end, with what it needs to decide what to say. */
export interface SettledRun {
  runId: string;
  scheduleId: string;
  scheduleName: string;
  userId: string;
  notify: ScheduleNotify;
  status: "pending" | "started" | "error" | "skipped";
  error: string | null;
  conversationId: string | null;
  /**
   * The fire's answer. `current` is false once the person retried or edited
   * it: that attempt is theirs, so the run is over without a word.
   */
  answer: {
    status: "streaming" | "complete" | "error" | "aborted";
    content: string;
    current: boolean;
  } | null;
  notifyMessage: string | null;
}

/** The fire's own answer ended, so there is something new in the chat. */
export const answered = (run: SettledRun) =>
  run.conversationId !== null &&
  run.answer?.current === true &&
  (run.answer.status === "complete" || run.answer.status === "error");

/**
 * What to tell the owner, if anything. A stop was the person, a skip was them
 * being busy in the chat, and a retried answer is theirs: none of those notify.
 */
export function runNotification(run: SettledRun): AppNotification | null {
  if (run.notify === "off") return null;
  const failed = (reason: string): AppNotification => ({
    id: run.runId,
    title: run.scheduleName,
    body: `Couldn’t finish: ${reason}`.slice(0, 400),
    path: run.conversationId ? `/chat/${run.conversationId}` : `/schedules/${run.scheduleId}`,
  });
  if (run.status === "error") return failed(run.error ?? "the run failed");
  if (!answered(run)) return null;
  if (run.answer!.status === "error") return failed("the answer stopped with an error");
  const body =
    run.notify === "conditional"
      ? run.notifyMessage
      : // An answer that is all tool work, or a question back, has no text to quote.
        answerExcerpt(run.answer!.content) || "The run finished.";
  if (!body) return null;
  return {
    id: run.runId,
    title: run.scheduleName,
    body: body.slice(0, 400),
    path: `/chat/${run.conversationId}`,
  };
}

/**
 * What the email adds to `runNotification`: the answer itself, when the run
 * finished one and the person asked to hear about every run rather than the
 * model's own message, and the schedule to change.
 */
export const runEmail = (run: SettledRun): NotificationEmail => ({
  answer:
    run.notify !== "conditional" && answered(run) && run.answer!.status === "complete"
      ? run.answer!.content
      : null,
  managePath: `/schedules/${run.scheduleId}`,
});
