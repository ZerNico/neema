import { Schema } from "effect";

/** An answer that would go past one of the person's limits; nothing was started. */
export class UsageLimitReached extends Schema.TaggedError<UsageLimitReached>()(
  "UsageLimitReached",
  {
    reason: Schema.String,
    /** When the limit that stopped it opens again, as an ISO time. */
    resetsAt: Schema.String,
  },
) {}

/** A rule or setting an admin tried to save that cannot hold. */
export class LimitRejected extends Schema.TaggedError<LimitRejected>()("LimitRejected", {
  reason: Schema.String,
}) {}

/** An upload that would take the person, or a project's owner, past their storage quota. */
export class StorageFull extends Schema.TaggedError<StorageFull>()("StorageFull", {
  reason: Schema.String,
}) {}
