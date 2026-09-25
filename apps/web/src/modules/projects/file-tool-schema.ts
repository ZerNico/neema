import { Option, Schema } from "effect";

export const ProjectFileToolName = Schema.Literals([
  "list_project_files",
  "read_project_file",
  "save_project_file",
]);
export type ProjectFileToolName = typeof ProjectFileToolName.Type;
export const ProjectFileOutcome = Schema.Literals([
  "listed",
  "read",
  "saved",
  "conflict",
  "invalid",
  "unavailable",
]);
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
/**
 * What a project file call leaves on its row and in the stream: which file,
 * which version, never its content. Handler-authored text only.
 */
export const ProjectFileActivityResult = Schema.Struct({
  outcome: ProjectFileOutcome,
  fileId: Schema.optionalKey(Id),
  fileName: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  version: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  message: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(600))),
});
export type ProjectFileActivityResult = typeof ProjectFileActivityResult.Type;

/** Rebuilt field by field, so file text the model saw can never ride along. */
export function projectProjectFileResult(value: unknown): ProjectFileActivityResult {
  const decoded = Schema.decodeUnknownOption(ProjectFileActivityResult)(value, {
    onExcessProperty: "ignore",
  });
  if (Option.isNone(decoded)) return { outcome: "invalid" };
  const { outcome, fileId, fileName, version, message } = decoded.value;
  return {
    outcome,
    ...(fileId ? { fileId } : {}),
    ...(fileName ? { fileName } : {}),
    ...(version ? { version } : {}),
    ...(message && !projectFileResultOk({ outcome }) ? { message } : {}),
  };
}
export const projectFileResultOk = (result: Pick<ProjectFileActivityResult, "outcome">) =>
  result.outcome === "listed" || result.outcome === "read" || result.outcome === "saved";

/** The handler's own explanation for a call that did not succeed. */
export function projectFileFailureReason(value: unknown): string | undefined {
  const result = projectProjectFileResult(value);
  return projectFileResultOk(result) ? undefined : result.message;
}

const fields = {
  v: Schema.Literal(1),
  family: Schema.Literal("project-file"),
  callId: Schema.String,
  name: ProjectFileToolName,
};
export const ProjectFileToolEnvelope = Schema.Union([
  Schema.Struct({
    ...fields,
    phase: Schema.Literal("start"),
    turnIndex: Schema.Int,
    callIndex: Schema.Int,
    textOffset: Schema.optionalKey(Schema.Int),
  }),
  Schema.Struct({
    ...fields,
    phase: Schema.Literal("result"),
    ...ProjectFileActivityResult.fields,
    reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(600))),
  }),
]);
export type ProjectFileToolEnvelope = typeof ProjectFileToolEnvelope.Type;
