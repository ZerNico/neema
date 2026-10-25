import { Schema } from "effect";
/** A resource the caller may not manage, or that is gone: the same answer, so neither leaks. */
export class SharedResourceNotAvailable extends Schema.TaggedError<SharedResourceNotAvailable>()(
  "SharedResourceNotAvailable",
  { resourceId: Schema.String },
) {}
export class SharingNotAllowed extends Schema.TaggedError<SharingNotAllowed>()(
  "SharingNotAllowed",
  { reason: Schema.String },
) {}
export class SharingRateLimited extends Schema.TaggedError<SharingRateLimited>()(
  "SharingRateLimited",
  {},
) {}
