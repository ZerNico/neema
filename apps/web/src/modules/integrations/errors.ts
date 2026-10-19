import { Schema } from "effect";

/**
 * Off, unconfigured, not shared with this person, or not connected. Names the integration when it
 * is known, and the account when an account was what could not be found.
 */
export class IntegrationNotAvailable extends Schema.TaggedError<IntegrationNotAvailable>()(
  "IntegrationNotAvailable",
  { integrationId: Schema.NullOr(Schema.String), connectionId: Schema.optionalKey(Schema.String) },
) {}

/** A request the person can fix: shown to them as written. */
export class IntegrationRejected extends Schema.TaggedError<IntegrationRejected>()(
  "IntegrationRejected",
  { reason: Schema.String },
) {}

export const CredentialIdentity = Schema.Struct({
  connectionId: Schema.String,
  accountEpoch: Schema.String,
  credentialRevision: Schema.String,
});
export type CredentialIdentity = typeof CredentialIdentity.Type;

/** A provider refusal names the exact request credential, never a session's last token. */
export class IntegrationAuthFailed extends Schema.TaggedError<IntegrationAuthFailed>()(
  "IntegrationAuthFailed",
  { integrationId: Schema.String, credential: Schema.optionalKey(CredentialIdentity) },
) {}

/** Any other failure talking to the service. The message is safe to show. */
export class IntegrationRequestFailed extends Schema.TaggedError<IntegrationRequestFailed>()(
  "IntegrationRequestFailed",
  {
    status: Schema.NullOr(Schema.Number),
    message: Schema.String,
    /** Scopes the service said the call lacked (a 403 `insufficient_scope`), to ask for next time. */
    missingScopes: Schema.optionalKey(Schema.Array(Schema.String)),
  },
) {}
