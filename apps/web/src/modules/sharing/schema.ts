import { Schema } from "effect";
import { EntityId } from "~/entity-id.ts";

export const SharedResource = Schema.Struct({
  kind: Schema.Literals(["agent", "collection", "skill", "customTool", "integration"]),
  id: EntityId,
});
export type SharedResource = typeof SharedResource.Type;
/** One change to who may use a resource; each is checked against the caller's sharing rights. */
export const SharingChange = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("email"),
    email: Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(254)),
  }),
  Schema.Struct({ action: Schema.Literal("group"), groupId: EntityId }),
  Schema.Struct({ action: Schema.Literal("revokeUser"), userId: EntityId }),
  Schema.Struct({ action: Schema.Literal("revokeGroup"), groupId: EntityId }),
  Schema.Struct({
    action: Schema.Literal("publish"),
    audience: Schema.Literals(["private", "instance"]),
  }),
]);
export type SharingChange = typeof SharingChange.Type;
export const ChangeSharingInput = Schema.Struct({
  ...SharedResource.fields,
  change: SharingChange,
});
export const RecipientSearchInput = Schema.Struct({
  q: Schema.String.check(Schema.isMaxLength(200)),
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
