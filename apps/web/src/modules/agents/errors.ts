import { Schema } from "effect";

/** `agentId` is null when the chat's agent was deleted, leaving no id to name. */
export class AgentNotAvailable extends Schema.TaggedError<AgentNotAvailable>()(
  "AgentNotAvailable",
  { agentId: Schema.NullOr(Schema.String) },
) {}
export class AgentRejected extends Schema.TaggedError<AgentRejected>()("AgentRejected", {
  reason: Schema.String,
}) {}
