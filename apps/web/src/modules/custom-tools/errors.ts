import { Schema } from "effect";

export class CustomToolNotFound extends Schema.TaggedError<CustomToolNotFound>()(
  "CustomToolNotFound",
  { toolId: Schema.String },
) {}

export class CustomToolSlugTaken extends Schema.TaggedError<CustomToolSlugTaken>()(
  "CustomToolSlugTaken",
  { slug: Schema.String },
) {}

export class CustomToolCompileFailed extends Schema.TaggedError<CustomToolCompileFailed>()(
  "CustomToolCompileFailed",
  { message: Schema.String },
) {}

/** The row moved since the editor loaded it; reload before saving. */
export class CustomToolConflict extends Schema.TaggedError<CustomToolConflict>()(
  "CustomToolConflict",
  { toolId: Schema.String },
) {}
