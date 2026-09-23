import { Schema } from "effect";

/** Off, unconfigured, not shared with this person, or not connected. */
export class IntegrationNotAvailable extends Schema.TaggedError<IntegrationNotAvailable>()(
  "IntegrationNotAvailable",
  { integrationId: Schema.String },
) {}

/** A request the person can fix: shown to them as written. */
export class IntegrationRejected extends Schema.TaggedError<IntegrationRejected>()(
  "IntegrationRejected",
  { reason: Schema.String },
) {}

/** The service refused the credentials; the connection needs reconnecting. */
export class IntegrationAuthFailed extends Schema.TaggedError<IntegrationAuthFailed>()(
  "IntegrationAuthFailed",
  { integrationId: Schema.String },
) {}

/** Any other failure talking to the service. The message is safe to show. */
export class IntegrationRequestFailed extends Schema.TaggedError<IntegrationRequestFailed>()(
  "IntegrationRequestFailed",
  { status: Schema.NullOr(Schema.Number), message: Schema.String },
) {}
