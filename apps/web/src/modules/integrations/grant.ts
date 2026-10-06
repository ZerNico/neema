import { Schema } from "effect";

export const ALLOWANCE_LIMITS = {
  /** Addresses one allowance may name. */
  targets: 20,
} as const;

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const AllowanceId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/));

/**
 * Consent a schedule gives up front, since nobody is present to approve
 * during a fire: the most an integration may do, and, under write access,
 * the exact people each of its allowances may reach.
 */
export const IntegrationGrant = Schema.Struct({
  integrationId: Id,
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
