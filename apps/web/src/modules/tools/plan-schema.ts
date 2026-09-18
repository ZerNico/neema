import { Schema } from "effect";

/**
 * The optional working checklist. One short list per generation, replaced
 * wholesale by each call, never a log of past lists.
 *
 * It is a statement of intent, not evidence: a completed step says the model
 * believes it did the work, and prompts and the UI must not present it as
 * proof that any document, source or requirement was actually covered.
 */
export const PLAN_LIMITS = { steps: 8, stepLength: 120 } as const;

export const PlanStepStatus = Schema.Literals(["pending", "in_progress", "completed"]);
export type PlanStepStatus = typeof PlanStepStatus.Type;

export const PlanStep = Schema.Struct({
  step: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(PLAN_LIMITS.stepLength),
    Schema.makeFilter((value) => value.trim().length > 0),
  ),
  status: PlanStepStatus,
});
export type PlanStep = typeof PlanStep.Type;

export const PlanSnapshot = Schema.Struct({
  steps: Schema.Array(PlanStep).check(Schema.isMinLength(1), Schema.isMaxLength(PLAN_LIMITS.steps)),
}).check(
  Schema.makeFilter(
    (value) =>
      value.steps.filter((step) => step.status === "in_progress").length <= 1 &&
      new Set(value.steps.map((step) => step.step.trim().toLowerCase())).size ===
        value.steps.length,
  ),
);
export type PlanSnapshot = typeof PlanSnapshot.Type;

export const PlanToolResult = Schema.Union([
  Schema.Struct({
    v: Schema.Literals([1]),
    outcome: Schema.Literals(["updated"]),
    ...PlanSnapshot.fields,
  }),
  Schema.Struct({
    v: Schema.Literals([1]),
    outcome: Schema.Literals(["rejected"]),
    message: Schema.String,
  }),
]);
export type PlanToolResult = typeof PlanToolResult.Type;

/** The reminder that carries the current list into the next model turn. */
export const renderPlanReminder = (snapshot: PlanSnapshot): string =>
  "Current checklist (your own working note, not evidence of completed work). " +
  "Call update_plan with the full list to change it:\n" +
  snapshot.steps
    .map(
      (step) =>
        `${step.status === "completed" ? "[x]" : step.status === "in_progress" ? "[~]" : "[ ]"} ${step.step}`,
    )
    .join("\n");
