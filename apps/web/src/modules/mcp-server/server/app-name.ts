import { Effect } from "effect";
import { apiKeyIdOf } from "~/modules/api-keys/schema.ts";
import { ApiKeys } from "~/modules/api-keys/server/service.ts";
import { ConnectedApps } from "./connected-apps.ts";

/** What provenance and decisions call the app behind a request: its own name, or the key's. */
export const appName = Effect.fn("mcp.appName")(function* (clientId: string) {
  const keyId = apiKeyIdOf(clientId);
  if (keyId) {
    const name = yield* ApiKeys.use((keys) => keys.name(keyId));
    return name === null ? "an API key" : `${name} (API key)`;
  }
  return (yield* ConnectedApps.use((apps) => apps.client(clientId)))?.name ?? "a connected app";
});
