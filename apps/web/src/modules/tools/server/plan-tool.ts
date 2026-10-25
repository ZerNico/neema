import { Effect, Option, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { PLAN_LIMITS, PlanSnapshot, PlanToolResult } from "../plan-schema.ts";
import { advertisedParameter, type ToolGroup } from "./toolset.ts";

// As with ask_user and save_memory, validate inside the handler so malformed
// model arguments come back as a recoverable tool result instead of failing
// parameter decoding mid-stream.
const TransportParams = Schema.Struct({
  steps: advertisedParameter({
    type: "array",
    minItems: 1,
    maxItems: PLAN_LIMITS.steps,
    items: {
      type: "object",
      required: ["step", "status"],
      properties: {
        step: { type: "string", minLength: 1, maxLength: PLAN_LIMITS.stepLength },
        status: { type: "string", enum: ["pending", "in_progress", "completed"] },
      },
    },
  }),
});

export const updatePlanTool = Tool.make("update_plan", {
  description:
    `Record or update a short working checklist of at most ${PLAN_LIMITS.steps} steps for a multi-step request. ` +
    "Send the complete list every time; it replaces the previous one. At most one step may be in_progress. " +
    "Skip it for simple requests. It is your own working note: marking a step completed is not evidence that the work was verified, and the answer must still disclose anything you could not cover.",
  parameters: TransportParams,
  success: PlanToolResult,
  failureMode: "return",
});

export interface PreparedPlanTool {
  readonly group: ToolGroup;
  /** The latest accepted list, for the trailing reminder. Null until one lands. */
  readonly current: () => PlanSnapshot | null;
}

/**
 * One checklist per generation. Each accepted call replaces it, so the prompt
 * carries a single current list rather than a history of revisions, and a
 * failed or stopped generation keeps the last honest snapshot. A resumed
 * answer starts from that snapshot.
 */
export function preparePlanTool(initial: PlanSnapshot | null = null): PreparedPlanTool {
  let current = initial;
  const handler = (params: { readonly steps?: unknown }) =>
    Effect.sync((): PlanToolResult => {
      const decoded = Schema.decodeUnknownOption(PlanSnapshot)(params);
      if (Option.isNone(decoded))
        return {
          v: 1,
          outcome: "rejected",
          message: `Send 1–${PLAN_LIMITS.steps} distinct steps, each up to ${PLAN_LIMITS.stepLength} characters with status pending, in_progress or completed, and at most one in_progress.`,
        };
      current = decoded.value;
      return { v: 1, outcome: "updated", steps: current.steps };
    });
  return {
    group: {
      family: "plan",
      toolkit: Toolkit.make(updatePlanTool),
      handlers: { update_plan: handler },
    },
    current: () => current,
  };
}
