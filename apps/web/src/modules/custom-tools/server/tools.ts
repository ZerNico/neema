import { Effect } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import type { ToolGroup } from "~/modules/tools/server/toolset.ts";
import { CUSTOM_TOOL_LIMITS, type CustomToolManifest } from "../schema.ts";
import type { CustomToolRunFile, CustomToolRuntime } from "./runtime.ts";

export interface PreparedCustomTools {
  readonly group: ToolGroup;
  /**
   * Files a call returned, keyed by the provider call id, waiting for the
   * engine to store them under the generation fence. The model's result part
   * is JSON and carries only their names; bytes never enter the transcript.
   * Taken exactly once, in the `tool-result` branch.
   */
  takeFiles(callId: string): ReadonlyArray<CustomToolRunFile>;
}

/**
 * Expands pinned module revisions into independently callable model tools. The
 * runtime is captured before toolkit merge so handlers do not depend on later
 * Effect context provision.
 */
export function prepareCustomTools(
  modules: ReadonlyArray<CustomToolManifest>,
  runtime: CustomToolRuntime["Service"],
): PreparedCustomTools | undefined {
  const functions = modules.flatMap((module) => module.functions.map((fn) => ({ module, fn })));
  if (functions.length === 0) return undefined;
  const pendingFiles = new Map<string, ReadonlyArray<CustomToolRunFile>>();

  const definitions = functions.map(({ fn }) =>
    Tool.dynamic(fn.modelName, {
      description: fn.description,
      parameters: fn.parametersSchema as never,
      failureMode: "return",
    }),
  );
  const handlers: Record<string, unknown> = {};
  for (const { module, fn } of functions) {
    handlers[fn.modelName] = (args: unknown, context: { readonly toolCallId: string }) =>
      runtime
        .run({
          compiled: module.compiled,
          functionKey: fn.key,
          args,
          timeoutMs: CUSTOM_TOOL_LIMITS.timeoutMs,
        })
        .pipe(
          Effect.map((result) => {
            if (!result.ok) {
              return {
                ok: false,
                ...(result.error === undefined ? {} : { error: result.error }),
              };
            }
            if (result.files?.length) pendingFiles.set(context.toolCallId, result.files);
            return {
              ok: true,
              ...(result.output === undefined ? {} : { output: result.output }),
              ...(result.files?.length
                ? {
                    files: result.files.map((item) => ({
                      name: item.name,
                      mediaType: item.mediaType,
                      size: item.bytes.length,
                    })),
                  }
                : {}),
            };
          }),
        );
  }

  return {
    group: { toolkit: Toolkit.make(...definitions) as ToolGroup["toolkit"], handlers },
    takeFiles: (callId) => {
      const files = pendingFiles.get(callId) ?? [];
      pendingFiles.delete(callId);
      return files;
    },
  };
}
