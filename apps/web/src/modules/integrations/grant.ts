import { Schema } from "effect";
import { EntityId } from "~/entity-id.ts";

export const ALLOWANCE_LIMITS = {
  /** Addresses one allowance may name. */
  targets: 20,
} as const;

const AllowanceId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/));

/**
 * Consent a schedule gives up front, since nobody is present to approve
 * during a fire: the most an integration may do, and, under write access,
 * the exact people each of its allowances may reach.
 */
export const IntegrationGrant = Schema.Struct({
  /** The owner's account the run acts as; a grant never reaches their others. */
  connectionId: EntityId,
  /** Which integration that account is on, for its allowances and its name. */
  integrationId: EntityId,
  access: Schema.Literals(["read", "write"]),
  allowances: Schema.optionalKey(
    Schema.Record(
      AllowanceId,
      Schema.Struct({
        targets: Schema.Array(Schema.String.check(Schema.isMaxLength(254))).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(ALLOWANCE_LIMITS.targets),
        ),
      }),
    ),
  ),
});
export type IntegrationGrant = typeof IntegrationGrant.Type;

/**
 * A grant as a schedule keeps it: the account is null once it was
 * disconnected, which the editor shows and a save or a fire refuses.
 */
export const ScheduleGrant = Schema.Struct({
  ...IntegrationGrant.fields,
  connectionId: Schema.NullOr(EntityId),
});
export type ScheduleGrant = typeof ScheduleGrant.Type;
