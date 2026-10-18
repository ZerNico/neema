import { Schema } from "effect";
import { MCP_SCOPES } from "~/modules/mcp-server/scopes.ts";

/** Marks a secret as one of ours, for the gate and for secret scanners. */
export const API_KEY_PREFIX = "nma_";

/** Keys one person may hold at once. */
export const MAX_API_KEYS = 25;

/** How long a new key lasts, in days; null never ends. */
export const API_KEY_DAYS = [30, 90, 365] as const;
export type ApiKeyLifetime = (typeof API_KEY_DAYS)[number] | null;

/** A key's client id where an app's would be: in provenance, request state and edits. */
export const apiKeyClientId = (id: string) => `key:${id}`;
export const apiKeyIdOf = (clientId: string) =>
  clientId.startsWith("key:") ? clientId.slice("key:".length) : null;

export const ApiKeyName = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(60));

export const NewApiKey = Schema.Struct({
  name: ApiKeyName,
  scopes: Schema.Array(Schema.Literals(MCP_SCOPES)).check(Schema.isMinLength(1)),
  lifetimeDays: Schema.NullOr(Schema.Literals(API_KEY_DAYS)),
});
export type NewApiKey = typeof NewApiKey.Type;

/** A key as Settings lists it; the secret itself is shown once, at creation. */
export interface ApiKeySummary {
  id: string;
  name: string;
  start: string;
  scopes: ReadonlyArray<string>;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}
