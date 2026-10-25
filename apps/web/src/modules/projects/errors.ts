import { Schema } from "effect";
import { Localized, localized } from "~/i18n/localized.ts";
import { m } from "~/paraglide/messages.js";

/** Missing, someone else's, or suspended: always reported the same way. */
export class ProjectNotAvailable extends Schema.TaggedError<ProjectNotAvailable>()(
  "ProjectNotAvailable",
  { projectId: Schema.String },
) {}
export class ProjectRejected extends Schema.TaggedError<ProjectRejected>()("ProjectRejected", {
  reason: Localized,
}) {}
/** A save based on a version the file has moved past. */
export class ProjectFileConflict extends Schema.TaggedError<ProjectFileConflict>()(
  "ProjectFileConflict",
  { basedOnVersion: Schema.Number, current: Schema.Number },
) {
  get reason() {
    return localized(m.projects_error_file_changed, {
      basedOn: this.basedOnVersion,
      current: this.current,
    });
  }
}
