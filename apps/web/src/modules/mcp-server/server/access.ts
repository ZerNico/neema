import { Effect } from "effect";
import { accountEligible } from "~/modules/auth/server/account-eligibility.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";

/** Whether this account may connect an app now: the check every MCP request makes. */
export const connectAppsAllowed = Effect.fn("mcp.connectAppsAllowed")(function* (userId: string) {
  if (!(yield* accountEligible(userId))) return false;
  return yield* FeaturePolicy.use((policy) => policy.can(userId, "mcp"));
});

/** A key acts through the MCP endpoint, so it needs that and its own capability. */
export const apiKeysAllowed = Effect.fn("mcp.apiKeysAllowed")(function* (userId: string) {
  if (!(yield* connectAppsAllowed(userId))) return false;
  return yield* FeaturePolicy.use((policy) => policy.can(userId, "apiKeys"));
});
