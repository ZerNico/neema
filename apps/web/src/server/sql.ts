import { Cause } from "effect";

/** `%` and `_` are wildcards in LIKE, so a user's literal text must escape them. */
export const escapeLike = (text: string): string => text.replaceAll(/[\\%_]/g, "\\$&");

/**
 * A unique violation reaches callers in two shapes depending on how deep the
 * driver error was wrapped: the tagged `UniqueViolation` the Effect SQL client
 * raises, and the raw Postgres `23505`. Either answers the same question, so
 * one place recognises both rather than each caller guessing which it will see.
 * Anything else is a real fault and must not be dressed up as a conflict.
 */
export const isUniqueViolation = (error: unknown): boolean => {
  const outer =
    typeof error === "object" && error !== null
      ? (error as { cause?: unknown }).cause
      : undefined;
  // Squash rather than assume an exact nesting depth.
  for (
    let current: unknown = Cause.isCause(outer) ? Cause.squash(outer) : error, depth = 0;
    depth < 5 && typeof current === "object" && current !== null;
    current = (current as { cause?: unknown }).cause, depth++
  ) {
    const node = current as { _tag?: unknown; code?: unknown; message?: unknown } & {
      reason?: { _tag?: unknown };
    };
    if (node._tag === "UniqueViolation" || node.reason?._tag === "UniqueViolation") return true;
    if (node.code === "23505") return true;
    if (typeof node.message === "string" && node.message.includes("duplicate key value"))
      return true;
  }
  return false;
};
