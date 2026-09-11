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
