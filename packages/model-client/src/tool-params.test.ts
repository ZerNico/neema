import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { chatSse, delta, effect, harness } from "./test-harness.ts";
import { dropEmptyOptionals } from "./tool-params.ts";

const Id = Schema.String.check(Schema.isMinLength(1)).annotate({ identifier: "Id" });
const create = Tool.make("create", {
  parameters: Schema.Struct({
    title: Schema.String,
    note: Schema.optionalKey(Schema.String),
    file: Schema.optionalKey(Id),
    scope: Schema.optionalKey(Schema.Literals(["chat", "project"])),
    label: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMinLength(1)))),
    count: Schema.optionalKey(Schema.Int),
    // `u`: Effect only advertises a pattern with Unicode semantics, as JSON Schema reads it.
    digits: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\d+$/u))),
    code: Schema.optionalKey(Id),
  }),
  success: Schema.Struct({ ok: Schema.Boolean }),
});

describe("dropEmptyOptionals", () => {
  it("drops an empty optional the schema cannot take, and keeps the rest as written", () => {
    expect(
      dropEmptyOptionals(
        {
          title: "",
          note: "",
          file: "",
          scope: "",
          label: "",
          count: "",
          digits: "",
          code: "c1",
          extra: "",
        },
        Tool.getJsonSchema(create),
      ),
    ).toEqual({ title: "", note: "", code: "c1", extra: "" });
  });
});

describe("empty optionals in a native call", () => {
  effect("decodes a call that fills every key, instead of failing the stream", () =>
    Effect.gen(function* () {
      const toolkit = yield* Toolkit.make(create).pipe(
        Effect.provide(
          Toolkit.make(create).toLayer({ create: () => Effect.succeed({ ok: true }) }),
        ),
      );
      const run = harness({
        preset: "custom",
        answers: [
          chatSse([
            delta({
              tool_calls: [
                {
                  index: 0,
                  id: "c1",
                  type: "function",
                  function: {
                    name: "create",
                    arguments: '{"title":"Brief","file":"","scope":"","note":""}',
                  },
                },
              ],
            }),
            delta({}, "tool_calls"),
          ]),
        ],
      });
      const parts = yield* run.stream("Hi", toolkit);
      expect(parts.find((part) => part.type === "tool-call")).toMatchObject({
        params: { title: "Brief", note: "" },
      });
      expect(parts.find((part) => part.type === "tool-result")).toMatchObject({
        result: { ok: true },
      });
    }),
  );
});
