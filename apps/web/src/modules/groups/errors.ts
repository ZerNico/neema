import { Schema } from "effect";

export class GroupNotFound extends Schema.TaggedError<GroupNotFound>()("GroupNotFound", {
  groupId: Schema.String,
}) {}

export class GroupNameTaken extends Schema.TaggedError<GroupNameTaken>()("GroupNameTaken", {
  name: Schema.String,
}) {}

export class GroupMemberNotFound extends Schema.TaggedError<GroupMemberNotFound>()(
  "GroupMemberNotFound",
  {
    groupId: Schema.String,
    userId: Schema.String,
  },
) {}

/** A feature the person's groups do not grant. */
export class CapabilityDenied extends Schema.TaggedError<CapabilityDenied>()("CapabilityDenied", {
  capability: Schema.String,
}) {}

/** A capability set that cannot hold, such as Create without Use. */
export class CapabilitiesRejected extends Schema.TaggedError<CapabilitiesRejected>()(
  "CapabilitiesRejected",
  { reason: Schema.String },
) {}
