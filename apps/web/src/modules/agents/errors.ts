import { Schema } from "effect";

/** `agentId` is null when the chat's agent was deleted, leaving no id to name. */
export class AgentNotAvailable extends Schema.TaggedError<AgentNotAvailable>()(
  "AgentNotAvailable",
  { agentId: Schema.NullOr(Schema.String) },
) {}
export class AgentRejected extends Schema.TaggedError<AgentRejected>()("AgentRejected", {
  reason: Schema.String,
}) {}
/** The agent moved past the revision a save was based on. */
export class AgentChanged extends Schema.TaggedError<AgentChanged>()("AgentChanged", {
  agentId: Schema.String,
}) {
  get reason() {
    return "agent changed; reload before saving";
  }
}
