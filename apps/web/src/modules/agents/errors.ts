import { Schema } from "effect";
import { Localized, localized } from "~/i18n/localized.ts";
import { m } from "~/paraglide/messages.js";

/** `agentId` is null when the chat's agent was deleted, leaving no id to name. */
export class AgentNotAvailable extends Schema.TaggedError<AgentNotAvailable>()(
  "AgentNotAvailable",
  { agentId: Schema.NullOr(Schema.String) },
) {}
export class AgentRejected extends Schema.TaggedError<AgentRejected>()("AgentRejected", {
  reason: Localized,
}) {}
/** The agent moved past the revision a save was based on. */
export class AgentChanged extends Schema.TaggedError<AgentChanged>()("AgentChanged", {
  agentId: Schema.String,
}) {
  get reason() {
    return localized(m.agents_error_changed);
  }
}
