import { Schema } from "effect";

export class AgentNotAvailable extends Schema.TaggedError<AgentNotAvailable>()(
  "AgentNotAvailable",
  { agentId: Schema.String },
) {}
export class AgentRejected extends Schema.TaggedError<AgentRejected>()("AgentRejected", {
  reason: Schema.String,
}) {}
