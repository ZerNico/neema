import { Schema } from "effect";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
export const SharedResource = Schema.Struct({
  kind: Schema.Literals(["agent", "collection", "skill"]),
  id: Id,
});
export type SharedResource = typeof SharedResource.Type;
export const ShareEmailInput = Schema.Struct({
  ...SharedResource.fields,
  email: Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(254)),
});
export const ShareGroupInput = Schema.Struct({ ...SharedResource.fields, groupId: Id });
export const RevokeUserInput = Schema.Struct({ ...SharedResource.fields, userId: Id });
export const RecipientSearchInput = Schema.Struct({
  q: Schema.String.check(Schema.isMaxLength(200)),
});
export const PublishResourceInput = Schema.Struct({
  ...SharedResource.fields,
  audience: Schema.Literals(["private", "instance"]),
});
/** A signed-in account offered by the sharing picker. */
export interface ShareRecipient {
  userId: string;
  name: string;
  email: string;
}
export interface ResourceGrants {
  audience: "private" | "instance";
  canPublish: boolean;
  users: ReadonlyArray<{ userId: string; name: string; email: string }>;
  groups: ReadonlyArray<{ groupId: string; name: string }>;
  eligibleGroups: ReadonlyArray<{ id: string; name: string }>;
}
