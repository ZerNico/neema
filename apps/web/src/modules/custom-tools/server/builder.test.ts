import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { TEMPLATE_SOURCE } from "../template.ts";
import { CustomToolBuilder } from "./builder.ts";
import { CustomToolInstaller, validateCustomToolDependencies } from "./installer.ts";
import { CustomToolRuntime } from "./runtime.ts";

const source = `
import { Schema, defineModule, defineTool, file } from "@chat/custom-tools";

const Shared = Schema.Struct({ value: Schema.String }).annotate({ identifier: "Shared" });

export default defineModule({
  echo: defineTool({
    name: "Echo",
    description: "Echo validated input.",
    parameters: Schema.Struct({ first: Shared, second: Shared }),
    run: ({ first, second }) => ({ first: first.value, second: second.value }),
  }),
  invalid_result: defineTool({
    name: "Invalid result",
    description: "Return a value JSON cannot represent.",
    parameters: Schema.Struct({}),
    run: () => 1n,
  }),
  cyclic_result: defineTool({
    name: "Cyclic result",
    description: "Return a cyclic value.",
    parameters: Schema.Struct({}),
    run: () => {
      const value: { self?: unknown } = {};
      value.self = value;
      return value;
    },
  }),
  callable_result: defineTool({
    name: "Callable result",
    description: "Return a function.",
    parameters: Schema.Struct({}),
    run: () => () => "no",
  }),
  symbolic_result: defineTool({
    name: "Symbolic result",
    description: "Return a symbol.",
    parameters: Schema.Struct({}),
    run: () => Symbol("no"),
  }),
  plain_result: defineTool({
    name: "Plain result",
    description: "Return plain text.",
    parameters: Schema.Struct({}),
    run: () => "plain text",
  }),
  empty_result: defineTool({
    name: "Empty result",
    description: "Return undefined.",
    parameters: Schema.Struct({}),
    run: () => undefined,
  }),
  hang: defineTool({
    name: "Hang",
    description: "Never resolve.",
    parameters: Schema.Struct({}),
    run: () => new Promise<never>(() => {}),
  }),
  report: defineTool({
    name: "Report",
    description: "Return text plus files.",
    parameters: Schema.Struct({}),
    run: () => ({
      text: { generated: 2 },
      files: [
        file("%PDF-1.4 minimal", { name: "report.pdf", mediaType: "application/pdf" }),
        file("a,b\\n1,2\\n", { name: "report.csv", mediaType: "text/csv", share: true }),
      ],
    }),
  }),
  lookalike: defineTool({
    name: "Lookalike",
    description: "A JSON result that only resembles the file form.",
    parameters: Schema.Struct({}),
    run: () => ({ files: [{ name: "not-a-file" }] }),
  }),
  too_many: defineTool({
    name: "Too many",
    description: "More files than a message may carry.",
    parameters: Schema.Struct({}),
    run: () => ({
      files: Array.from({ length: 6 }, (_, index) =>
        file("x", { name: "f" + index + ".txt", mediaType: "text/plain" }),
      ),
    }),
  }),
});
`;

const withCore = <A, E>(run: Effect.Effect<A, E, CustomToolBuilder | CustomToolRuntime>) =>
  Effect.scoped(
    Effect.acquireUseRelease(
      Effect.tryPromise(() => mkdtemp(join(tmpdir(), "chat-custom-tools-"))),
      (root) => {
        const config = ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            CUSTOM_TOOL_PACKAGE_ROOT: root,
            CUSTOM_TOOL_WORKERS: 1,
          }),
        );
        const dependencies = Layer.merge(CustomToolInstaller.layer, CustomToolRuntime.layer).pipe(
          Layer.provide(config),
        );
        const layer = CustomToolBuilder.layer.pipe(Layer.provideMerge(dependencies));
        return run.pipe(Effect.provide(layer));
      },
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
    ),
  );

describe("custom tool core", () => {
  it.effect("builds and runs the editor template as shipped", () =>
    withCore(
      Effect.gen(function* () {
        const builder = yield* CustomToolBuilder;
        const runtime = yield* CustomToolRuntime;
        const build = yield* builder.build({
          slug: "starter",
          source: TEMPLATE_SOURCE,
          dependencies: [],
        });
        expect(build.functions.map((fn) => fn.modelName)).toEqual([
          "custom_starter__echo",
          "custom_starter__shout_file",
        ]);
        // The model sees a plain string it fills with a file's id or name.
        expect(build.functions[1]?.parametersSchema).toMatchObject({
          properties: {
            source: {
              type: "string",
              description: expect.stringContaining("Accepts .txt, .md."),
            },
          },
        });
        expect(build.functions[0]?.parametersSchema).toMatchObject({
          type: "object",
          properties: { text: { type: "string", description: "Text to echo" } },
        });
        const result = yield* runtime.run({
          compiled: build.compiled,
          functionKey: "echo",
          args: { text: "hi" },
          timeoutMs: 5_000,
        });
        expect(result).toMatchObject({ ok: true, output: "You said: hi" });

        const asked: string[] = [];
        const notes = {
          name: "notes.md",
          mediaType: "text/plain",
          bytes: new TextEncoder().encode("hi"),
        };
        const shout = (reference: string) =>
          runtime.run({
            compiled: build.compiled,
            functionKey: "shout_file",
            args: { source: reference },
            timeoutMs: 5_000,
            resolveFile: (name) => {
              asked.push(name);
              if (name === "notes.md") return Effect.succeed(notes);
              if (name === "photo.png")
                return Effect.succeed({ ...notes, name, mediaType: "image/png" });
              return Effect.fail(`No file named ${name}.`);
            },
          });
        const shouted = yield* shout("notes.md");
        expect(shouted).toMatchObject({ ok: true, output: "Upper-cased notes.md (2 bytes)." });
        expect(new TextDecoder().decode(shouted.files?.[0]?.bytes)).toBe("HI");
        expect(shouted.files?.[0]?.name).toBe("loud-notes.md");
        // The host's reason and the tool's accept list both reach the model.
        expect((yield* shout("missing.md")).error).toContain("No file named missing.md.");
        expect((yield* shout("photo.png")).error).toContain("photo.png is image/png");
        expect(asked).toEqual(["notes.md", "missing.md", "photo.png"]);
        // Without a resolver (no chat to read from), the call explains itself.
        const bare = yield* runtime.run({
          compiled: build.compiled,
          functionKey: "shout_file",
          args: { source: "notes.md" },
          timeoutMs: 5_000,
        });
        expect(bare.error).toContain("Files are not available here.");
      }),
    ),
  );

  it("accepts exact registry dependencies and rejects unsafe specs", () => {
    expect(validateCustomToolDependencies([{ name: "yaml", version: "2.9.0" }])).toEqual([
      { name: "yaml", version: "2.9.0" },
    ]);
    for (const version of [
      "^2.9.0",
      "latest",
      "npm:yaml@2.9.0",
      "git+https://example.test/x.git",
      "file:../x",
    ]) {
      expect(() => validateCustomToolDependencies([{ name: "yaml", version }])).toThrow(
        "exact registry version",
      );
    }
    expect(() =>
      validateCustomToolDependencies([
        { name: "yaml", version: "2.9.0" },
        { name: "yaml", version: "2.8.0" },
      ]),
    ).toThrow("declared more than once");
    expect(() => validateCustomToolDependencies([{ name: "effect", version: "4.0.0" }])).toThrow(
      "supplied by the custom tool runtime",
    );
  });

  it.effect("typechecks, bundles, inspects and invokes an authored module", () =>
    withCore(
      Effect.gen(function* () {
        const builder = yield* CustomToolBuilder;
        const runtime = yield* CustomToolRuntime;
        const build = yield* builder.build({ slug: "sample", source, dependencies: [] });

        expect(build.compiled).toContain("sourceMappingURL=data:application/json");
        expect(build.functions.map((fn) => fn.modelName)).toEqual([
          "custom_sample__echo",
          "custom_sample__invalid_result",
          "custom_sample__cyclic_result",
          "custom_sample__callable_result",
          "custom_sample__symbolic_result",
          "custom_sample__plain_result",
          "custom_sample__empty_result",
          "custom_sample__hang",
          "custom_sample__report",
          "custom_sample__lookalike",
          "custom_sample__too_many",
        ]);
        expect(build.functions[0]?.parametersSchema.$defs).toBeDefined();
        const cached = yield* builder.build({ slug: "sample", source, dependencies: [] });
        expect(cached).toBe(build);

        const result = yield* runtime.run({
          compiled: build.compiled,
          functionKey: "echo",
          args: { first: { value: "a" }, second: { value: "b" } },
          timeoutMs: 5_000,
          captureLogs: true,
        });
        expect(result).toMatchObject({
          ok: true,
          output: '{\n  "first": "a",\n  "second": "b"\n}',
          logs: [],
        });

        const invalidArgs = yield* runtime.run({
          compiled: build.compiled,
          functionKey: "echo",
          args: {},
          timeoutMs: 5_000,
        });
        expect(invalidArgs.ok).toBe(false);

        const invalidResult = yield* runtime.run({
          compiled: build.compiled,
          functionKey: "invalid_result",
          args: {},
          timeoutMs: 5_000,
        });
        expect(invalidResult).toMatchObject({
          ok: false,
          error: expect.stringContaining("BigInt"),
        });

        for (const [functionKey, error] of [
          ["cyclic_result", "cycles"],
          ["callable_result", "functions"],
          ["symbolic_result", "symbols"],
        ] as const) {
          const rejected = yield* runtime.run({
            compiled: build.compiled,
            functionKey,
            args: {},
            timeoutMs: 5_000,
          });
          expect(rejected).toMatchObject({ ok: false, error: expect.stringContaining(error) });
        }

        const plain = yield* runtime.run({
          compiled: build.compiled,
          functionKey: "plain_result",
          args: {},
          timeoutMs: 5_000,
        });
        expect(plain.output).toBe("plain text");

        const empty = yield* runtime.run({
          compiled: build.compiled,
          functionKey: "empty_result",
          args: {},
          timeoutMs: 5_000,
        });
        expect(empty.output).toBe("");

        const timedOut = yield* runtime.run({
          compiled: build.compiled,
          functionKey: "hang",
          args: {},
          timeoutMs: 25,
        });
        expect(timedOut).toMatchObject({
          ok: false,
          error: expect.stringContaining("did not finish"),
        });

        const afterReplacement = yield* runtime.run({
          compiled: build.compiled,
          functionKey: "echo",
          args: { first: { value: "c" }, second: { value: "d" } },
          timeoutMs: 5_000,
        });
        expect(afterReplacement.ok).toBe(true);

        // Files cross the worker boundary beside the text, bytes intact.
        const report = yield* runtime.run({
          compiled: build.compiled,
          functionKey: "report",
          args: {},
          timeoutMs: 5_000,
        });
        expect(report).toMatchObject({ ok: true, output: '{\n  "generated": 2\n}' });
        expect(report.files?.map((item) => [item.name, item.mediaType, item.share])).toEqual([
          ["report.pdf", "application/pdf", false],
          ["report.csv", "text/csv", true],
        ]);
        expect(Buffer.from(report.files![1]!.bytes).toString()).toBe("a,b\n1,2\n");

        // Without the brand the object is an ordinary JSON result.
        const lookalike = yield* runtime.run({
          compiled: build.compiled,
          functionKey: "lookalike",
          args: {},
          timeoutMs: 5_000,
        });
        expect(lookalike).toMatchObject({
          ok: true,
          output: expect.stringContaining("not-a-file"),
        });
        expect(lookalike.files).toBeUndefined();

        const tooMany = yield* runtime.run({
          compiled: build.compiled,
          functionKey: "too_many",
          args: {},
          timeoutMs: 5_000,
        });
        expect(tooMany).toMatchObject({ ok: false, error: expect.stringContaining("at most 5") });
      }),
    ),
  );
});
