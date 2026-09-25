import { describe, expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { Tool } from "effect/unstable/ai";
import { renderHermesSystemBlock } from "~/modules/providers/server/hermes-tools.ts";
import { mergeToolGroups } from "~/modules/tools/server/toolset.ts";
import { CUSTOM_TOOL_LIMITS, type CustomToolManifest } from "../schema.ts";
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

  it.effect("reports which files a call read, and stops at the per-call limit", () =>
    Effect.gen(function* () {
      // Stands in for the worker: asks for each named file in turn.
      const reading = CustomToolRuntime.of({
        inspect: () => Effect.succeed([]),
        run: ({ args, resolveFile }) =>
          Effect.gen(function* () {
            const names = (args as { files: string[] }).files;
            for (const name of names) {
              const outcome = yield* Effect.result(resolveFile!(name));
              if (outcome._tag === "Failure")
                return { ok: false, error: outcome.failure, logs: [], durationMs: 1 };
            }
            return { ok: true, output: "read", logs: [], durationMs: 1 };
          }),
      });
      const prepared = prepareCustomTools([moduleRevision], reading, (name) =>
        Effect.succeed({
          name,
          mediaType: "text/plain",
          bytes: new Uint8Array(1),
          source:
            name === "deck.pptx"
              ? { kind: "project" as const, fileId: "file-1", version: 3 }
              : { kind: "chat" as const, attachmentId: `att-${name}` },
        }),
      );
      const toolkit = yield* mergeToolGroups([prepared!.group]);
      const call = (files: string[]) =>
        toolkit!.handle("custom_weather__current", { files }).pipe(
          Effect.flatMap(Stream.runCollect),
          Effect.map((parts) => [...parts].at(-1)?.result),
        );

      expect(yield* call(["deck.pptx", "logo.png"])).toEqual({
        ok: true,
        output: "read",
        inputs: [
          { name: "deck.pptx", source: { kind: "project", fileId: "file-1", version: 3 } },
          { name: "logo.png", source: { kind: "chat", attachmentId: "att-logo.png" } },
        ],
      });
      const tooMany = Array.from(
        { length: CUSTOM_TOOL_LIMITS.inputFiles + 1 },
        (_, i) => `f${i}.txt`,
      );
      expect(yield* call(tooMany)).toEqual({
        ok: false,
        error: `A call may read at most ${CUSTOM_TOOL_LIMITS.inputFiles} files.`,
      });
    }),
  );
});
