import { Schema } from "effect";

export const GenerationMode = Schema.Literals(["chat", "research"]);
export type GenerationMode = typeof GenerationMode.Type;
export const ResearchPhase = Schema.Literals([
  "queued",
  "clarifying",
  "planning",
  "researching",
  "synthesizing",
  "complete",
  "awaiting_answer",
  "partial",
  "aborted",
  "interrupted",
  "error",
]);
export type ResearchPhase = typeof ResearchPhase.Type;
export const ResearchTaskProgress = Schema.Struct({
  id: Schema.String,
  ordinal: Schema.Int,
  title: Schema.String,
  status: Schema.Literals(["queued", "running", "complete", "error", "aborted"]),
  error: Schema.optionalKey(Schema.String),
});
export type ResearchTaskProgress = typeof ResearchTaskProgress.Type;
/** A bounded full snapshot, not a patch: replay and live updates use the same reducer. */
export const ResearchProgress = Schema.Struct({
  runId: Schema.String,
  phase: ResearchPhase,
  tasks: Schema.Array(ResearchTaskProgress),
  limitations: Schema.Array(Schema.String),
  usageComplete: Schema.Boolean,
});
export type ResearchProgress = typeof ResearchProgress.Type;

/** Internal plans and reports never cross the durable display boundary. */
export const projectResearchProgress = (progress: ResearchProgress): ResearchProgress => ({
  runId: progress.runId,
  phase: progress.phase,
  tasks: progress.tasks.map(({ id, ordinal, title, status, error }) => ({
    id,
    ordinal,
    title,
    status,
    ...(error !== undefined ? { error } : {}),
  })),
  limitations: [...progress.limitations],
  usageComplete: progress.usageComplete,
});
