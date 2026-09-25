import { Schema } from "effect";

/** Missing, someone else's, or suspended: always reported the same way. */
export class ProjectNotAvailable extends Schema.TaggedError<ProjectNotAvailable>()(
  "ProjectNotAvailable",
  { projectId: Schema.String },
) {}
export class ProjectRejected extends Schema.TaggedError<ProjectRejected>()("ProjectRejected", {
  reason: Schema.String,
}) {}
