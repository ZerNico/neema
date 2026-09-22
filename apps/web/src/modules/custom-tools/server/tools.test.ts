import { describe, expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { Tool } from "effect/unstable/ai";
import { renderHermesSystemBlock } from "~/modules/providers/server/hermes-tools.ts";
import { mergeToolGroups } from "~/modules/tools/server/toolset.ts";
import type { CustomToolManifest } from "../schema.ts";
import { CustomToolRuntime } from "./runtime.ts";
import { prepareCustomTools } from "./tools.ts";

const runtime = CustomToolRuntime.of({
  inspect: () => Effect.succeed([]),
  run: ({ functionKey, args }) =>
    Effect.succeed({
      ok: true,
      output: JSON.stringify({ functionKey, args }),
      logs: [],
      durationMs: 1,
    }),
});

const moduleRevision: CustomToolManifest = {
  toolId: "tool-weather",
  slug: "weather",
  name: "Weather",
  description: "Weather functions.",
  compiled: "compiled module",
  functions: [
    {
      key: "current",
      name: "Current weather",
      description: "Read current weather.",
      modelName: "custom_weather__current",
      parametersSchema: {
        type: "object",
        properties: { city: { type: "string" }, unit: { $ref: "#/$defs/Unit" } },
        required: ["city"],
        $defs: { Unit: { type: "string", enum: ["c", "f"] } },
      },
    },
    {
      key: "forecast",
      name: "Forecast",
      description: "Read the forecast.",
      modelName: "custom_weather__forecast",
      parametersSchema: { type: "object", properties: {} },
    },
  ],
};

describe("prepareCustomTools", () => {
  it("returns undefined for no modules", () => {
    expect(prepareCustomTools([], runtime)).toBeUndefined();
  });

  it.effect("expands each pinned module function into the toolkit", () =>
    Effect.gen(function* () {
      const prepared = prepareCustomTools([moduleRevision], runtime);
      const toolkit = yield* mergeToolGroups([prepared!.group]);
      expect(Object.keys(toolkit!.tools)).toEqual([
        "custom_weather__current",
        "custom_weather__forecast",
      ]);

      const stream = yield* toolkit!.handle("custom_weather__current", { city: "Berlin" });
      const parts = yield* Stream.runCollect(stream);
      expect([...parts].at(-1)?.result).toEqual({
        ok: true,
        output: JSON.stringify({ functionKey: "current", args: { city: "Berlin" } }),
      });
    }),
  );

  it.effect("exposes the stored provider schema", () =>
    Effect.gen(function* () {
      const prepared = prepareCustomTools([moduleRevision], runtime);
      const toolkit = yield* mergeToolGroups([prepared!.group]);
      const tool = toolkit!.tools["custom_weather__current"]!;
      expect(Tool.getJsonSchema(tool as never)).toEqual(
        moduleRevision.functions[0]!.parametersSchema,
      );
      expect(renderHermesSystemBlock([tool as never], "auto")).toContain('"$defs":{"Unit"');
    }),
  );
});
