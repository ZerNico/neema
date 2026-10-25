import { Schema } from "effect";

/** Missing, someone else's, or suspended: always reported the same way. */
export class ProjectNotAvailable extends Schema.TaggedError<ProjectNotAvailable>()(
  "ProjectNotAvailable",
  { projectId: Schema.String },
) {}
export class ProjectRejected extends Schema.TaggedError<ProjectRejected>()("ProjectRejected", {
  reason: Schema.String,
}) {}
/** A save based on a version the file has moved past. */
export class ProjectFileConflict extends Schema.TaggedError<ProjectFileConflict>()(
  "ProjectFileConflict",
  { basedOnVersion: Schema.Number, current: Schema.Number },
) {
  get reason() {
    return `the file changed since version ${this.basedOnVersion}; it is at version ${this.current} now`;
  }
}
