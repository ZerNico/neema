import { createServerFn } from "@tanstack/react-start";
import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { requireAdmin, requireSession } from "~/modules/auth/server/middleware.ts";
import { runServerFn } from "~/server/run-server-fn.ts";
import { formatFileRef } from "../authoring.ts";
import { CustomToolNotFound } from "../errors.ts";
import {
  CheckCustomToolInput,
  CustomToolIdInput,
  SaveCustomToolInput,
  SetCustomToolEnabledInput,
  TestCustomToolInput,
  CUSTOM_TOOL_LIMITS,
  type CustomToolBuildPreview,
  type CustomToolDetail,
  type CustomToolSummary,
  type CustomToolTestResult,
} from "../schema.ts";
import { classifyFile } from "~/modules/attachments/server/validation.ts";
import { CustomToolBuilder } from "./builder.ts";
import { CustomToolRepo, type CustomToolSummaryRow } from "./repo.ts";
import { CustomToolRuntime } from "./runtime.ts";

const standard = Schema.toStandardSchemaV1;

const toSummary = (row: CustomToolSummaryRow): CustomToolSummary => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  description: row.description,
  enabled: row.enabled,
  audience: row.audience,
  version: row.version,
  functionCount: row.functions.length,
  dependencyCount: row.dependencies.length,
  updatedAt: row.updatedAt.toISOString(),
});

export const listCustomTools = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() =>
    runServerFn(
      CustomToolRepo.use((repo) => repo.list()).pipe(Effect.map((rows) => rows.map(toSummary))),
    ),
  );

export const getCustomTool = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .validator(standard(CustomToolIdInput))
  .handler(({ data }) =>
    runServerFn(
      Effect.gen(function* () {
        const repo = yield* CustomToolRepo;
        const stored = yield* repo.get(data.toolId);
        if (!stored) return yield* new CustomToolNotFound({ toolId: data.toolId });
        return {
          ...toSummary(stored),
          source: stored.source,
          dependencies: stored.dependencies,
          functions: stored.functions,
        } satisfies CustomToolDetail;
      }),
    ),
  );

export const checkCustomTool = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(CheckCustomToolInput))
  .handler(({ data }) =>
    runServerFn(
      CustomToolBuilder.use((builder) => builder.build(data)).pipe(
        Effect.map((build) => ({ functions: build.functions }) satisfies CustomToolBuildPreview),
      ),
    ),
  );

export const saveCustomTool = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(SaveCustomToolInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.gen(function* () {
        const repo = yield* CustomToolRepo;
        const builder = yield* CustomToolBuilder;
        const publish = { name: data.name, description: data.description };
        const compile = (slug: string) =>
          builder.build({ slug, source: data.source, dependencies: data.dependencies });
        if ("toolId" in data) {
          // A rename re-derives every model-facing name, so the build runs
          // against the submitted slug rather than the stored one.
          const build = yield* compile(data.slug);
          return toSummary(
            yield* repo.update(data.toolId, data.expectedVersion, {
              ...publish,
              slug: data.slug,
              build,
            }),
          );
        }
        const build = yield* compile(data.slug);
        return toSummary(
          yield* repo.create({
            ...publish,
            slug: data.slug,
            build,
            createdBy: context.session.user.id,
          }),
        );
      }),
    ),
  );

export const setCustomToolEnabled = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(SetCustomToolEnabledInput))
  .handler(({ data }) =>
    runServerFn(
      CustomToolRepo.use((repo) => repo.setEnabled(data.toolId, data.enabled)).pipe(
        Effect.map(toSummary),
      ),
    ),
  );

export const deleteCustomTool = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(CustomToolIdInput))
  .handler(({ data }) => runServerFn(CustomToolRepo.use((repo) => repo.remove(data.toolId))));

export const testCustomTool = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(TestCustomToolInput))
  .handler(({ data }) =>
    runServerFn(
      Effect.gen(function* () {
        let args: unknown;
        try {
          args = JSON.parse(data.argumentsJson);
        } catch {
          return {
            ok: false,
            output: "The arguments are not valid JSON.",
            durationMs: 0,
            logs: [],
            files: [],
          } satisfies CustomToolTestResult;
        }
        const builder = yield* CustomToolBuilder;
        const toolRuntime = yield* CustomToolRuntime;
        const build = yield* builder.build(data);
        const testFiles = (data.files ?? []).map((item) => {
          const bytes = new Uint8Array(Buffer.from(item.base64, "base64"));
          return {
            name: item.name,
            bytes,
            mediaType: classifyFile(item.name, "", bytes).mediaType,
            // Picked for this one run, like an answer's working files: they
            // are gone when it ends, so they carry that kind of reference.
            ref: { kind: "working" as const, id: randomUUID(), revision: 1 },
          };
        });
        if (
          testFiles.reduce((sum, item) => sum + item.bytes.length, 0) >
          CUSTOM_TOOL_LIMITS.testInputBytes
        )
          return {
            ok: false,
            output: "The test files are too large together.",
            durationMs: 0,
            logs: [],
            files: [],
          } satisfies CustomToolTestResult;
        const result = yield* toolRuntime.run({
          compiled: build.compiled,
          functionKey: data.functionKey,
          args,
          timeoutMs: CUSTOM_TOOL_LIMITS.testTimeoutMs,
          captureLogs: true,
          // A Test has no chat: its file parameters name the files picked for it.
          resolveFile: (reference) => {
            const found = testFiles.find(
              (item) =>
                item.name === reference.trim() || formatFileRef(item.ref) === reference.trim(),
            );
            return found
              ? Effect.succeed(found)
              : Effect.fail(`No test file named ${JSON.stringify(reference)}.`);
          },
        });
        return {
          ok: result.ok,
          output: result.output ?? result.error ?? "",
          durationMs: result.durationMs,
          logs: result.logs,
          // No message to attach to from Test; small files preview inline.
          files: (result.files ?? []).map((item) => ({
            name: item.name,
            mediaType: item.mediaType,
            size: item.bytes.length,
            ...(item.bytes.length <= CUSTOM_TOOL_LIMITS.testFileBytes
              ? {
                  dataUrl: `data:${item.mediaType};base64,${Buffer.from(item.bytes).toString("base64")}`,
                }
              : {}),
          })),
        } satisfies CustomToolTestResult;
      }),
    ),
  );

/** What a user may pick for an agent: no source, no bundles. */
export const listUsableCustomTools = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runServerFn(
      CustomToolRepo.use((repo) => repo.listUsableBy(context.session.user.id)).pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            id: row.id,
            slug: row.slug,
            name: row.name,
            description: row.description,
            functionCount: row.functions.length,
            functions: row.functions.map((fn) => fn.name),
          })),
        ),
      ),
    ),
  );
