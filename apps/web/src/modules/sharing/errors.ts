import { Schema } from "effect";
export class SharingRateLimited extends Schema.TaggedError<SharingRateLimited>()(
  "SharingRateLimited",
  {},
) {}
