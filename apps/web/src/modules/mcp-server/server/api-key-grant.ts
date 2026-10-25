import { Effect } from "effect";
import { apiKeyClientId } from "~/modules/api-keys/schema.ts";
import { ApiKeys } from "~/modules/api-keys/server/service.ts";
import type { McpGrant } from "~/modules/auth/server/mcp-access.ts";
import { apiKeysAllowed } from "./access.ts";

/** How far ahead a key's grant claims to hold; the key is checked again on every request. */
const GRANT_SECONDS = 60;

/**
 * The grant an API key holds, shaped like an OAuth token's so nothing past the
 * gate tells them apart. A key is made for this instance, so its audience is
 * the endpoint; whether keys are allowed is read on every request.
 */
export const apiKeyGrant = Effect.fn("mcp.apiKeyGrant")(function* (
  secret: string,
  resource: string,
) {
  const key = yield* ApiKeys.use((keys) => keys.verify(secret));
  if (!key) return null;
  if (!(yield* apiKeysAllowed(key.userId))) return null;
  return {
    userId: key.userId,
    clientId: apiKeyClientId(key.id),
    scopes: key.scopes,
    audience: [resource],
    // The SDK refuses a token with no expiry and judges one by this process's
    // clock. A short horizon serves both: a key that never ends still has one,
    // and the database, which verify asked, stays the only judge of the end.
    expiresAt: Math.floor(Date.now() / 1000) + GRANT_SECONDS,
  } satisfies McpGrant;
});
