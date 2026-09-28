import { Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { advertisedParameter, type ToolGroup } from "~/modules/tools/server/toolset.ts";
import { parseFileRef } from "./file-ref.ts";
import type { WorkingFiles, WorkingFileRef, WorkingFileSnapshot } from "./working-files.ts";

const tool = Tool.make("publish_file", {
  description:
    "Deliver an exact working-file revision as one final downloadable attachment. Use the working reference returned by an editing tool. An unpublished draft stays in this chat for a later answer but is not delivered until published. Finished one-shot custom exports deliver themselves and do not need this call.",
  parameters: Schema.Struct({
    ref: advertisedParameter({ type: "string" }),
    name: advertisedParameter({ type: "string" }),
  }),
  success: Schema.Struct({
    ok: Schema.Boolean,
    ref: Schema.optionalKey(Schema.String),
    name: Schema.optionalKey(Schema.String),
    attachmentId: Schema.optionalKey(Schema.String),
    error: Schema.optionalKey(Schema.String),
  }),
  failureMode: "return",
});

export interface PendingPublication {
  readonly ref: WorkingFileRef;
  readonly file: WorkingFileSnapshot;
  readonly name: string;
}

/**
 * The handler only seals the revision; the engine registers the attachment
 * under the generation fence when it reads the result, then settles the seal.
 */
export function preparePublishFileTool(workspace: WorkingFiles): {
  readonly group: ToolGroup;
  readonly take: (callId: string) => PendingPublication | undefined;
} {
  const pending = new Map<string, PendingPublication>();
  return {
    group: {
      toolkit: Toolkit.make(tool),
      handlers: {
        publish_file: (
          args: { readonly ref?: unknown; readonly name?: unknown },
          context: { readonly toolCallId: string },
        ) =>
          Effect.promise(async () => {
            const ref = typeof args.ref === "string" ? parseFileRef(args.ref) : undefined;
            if (ref?.kind !== "working")
              return { ok: false, error: "Pass an exact working-file reference." };
            if (args.name !== undefined && (typeof args.name !== "string" || !args.name.trim()))
              return { ok: false, error: "Provide a nonempty display filename." };
            try {
              await workspace.load(ref);
              const publication = workspace.preparePublish(ref);
              if (publication.state === "published")
                return { ok: true, ref: args.ref, attachmentId: publication.attachmentId };
              const name = typeof args.name === "string" ? args.name.trim() : publication.file.name;
              pending.set(context.toolCallId, { ref, file: publication.file, name });
              return { ok: true, ref: args.ref, name };
            } catch (cause) {
              return {
                ok: false,
                error: cause instanceof Error ? cause.message : "Publication failed.",
              };
            }
          }),
      },
    },
    take: (callId) => {
      const value = pending.get(callId);
      pending.delete(callId);
      return value;
    },
  };
}
