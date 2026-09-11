import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { PLAN_LIMITS } from "../plan-schema.ts";
import { preparePlanTool, updatePlanTool } from "./plan-tool.ts";

const call = (tool: ReturnType<typeof preparePlanTool>, params: unknown) =>
  Effect.runSync(
    (tool.group.handlers as { update_plan: (p: unknown) => Effect.Effect<unknown> }).update_plan(
      params,
    ),
  );
const steps = (...values: Array<[string, "pending" | "in_progress" | "completed"]>) => ({
  steps: values.map(([step, status]) => ({ step, status })),
});

describe("update_plan", () => {
  it("replaces the whole list rather than accumulating revisions", () => {
    const tool = preparePlanTool();
    expect(tool.current()).toBeNull();
    expect(
      call(tool, steps(["Read the contract", "in_progress"], ["Compare terms", "pending"])),
    ).toMatchObject({ outcome: "updated" });
    expect(tool.current()?.steps).toHaveLength(2);
    call(tool, steps(["Compare terms", "completed"]));
    expect(tool.current()?.steps).toEqual([{ step: "Compare terms", status: "completed" }]);
  });

  it("refuses malformed lists and keeps the last accepted one", () => {
    const tool = preparePlanTool();
    call(tool, steps(["Read the contract", "pending"]));
    const rejections = [
      { steps: [] },
      {},
      { steps: "later" },
      steps(["Alpha", "in_progress"], ["Beta", "in_progress"]),
      steps(["Same", "pending"], ["same", "completed"]),
      steps([" ", "pending"]),
      steps(["x".repeat(PLAN_LIMITS.stepLength + 1), "pending"]),
      {
        steps: Array.from({ length: PLAN_LIMITS.steps + 1 }, (_, i) => ({
          step: `S${i}`,
          status: "pending",
        })),
      },
      steps(["Alpha", "done" as never]),
    ];
    for (const params of rejections)
      expect(call(tool, params)).toMatchObject({ outcome: "rejected" });
    expect(tool.current()?.steps).toEqual([{ step: "Read the contract", status: "pending" }]);
  });

  it("offers one tool whose schema bounds the list for the provider", () => {
    const tool = preparePlanTool();
    expect(Object.keys(tool.group.handlers)).toEqual(["update_plan"]);
    const schema = Schema.toJsonSchemaDocument(updatePlanTool.parametersSchema).schema;
    expect(schema).toMatchObject({
      properties: {
        steps: {
          type: "array",
          minItems: 1,
          maxItems: PLAN_LIMITS.steps,
          items: { required: ["step", "status"] },
        },
      },
    });
    expect(call(tool, steps(["Only step", "completed"]))).toEqual({
      v: 1,
      outcome: "updated",
      steps: [{ step: "Only step", status: "completed" }],
    });
  });
});
