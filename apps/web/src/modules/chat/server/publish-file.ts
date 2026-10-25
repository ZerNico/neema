import { Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { advertisedParameter, type ToolGroup } from "~/modules/tools/server/toolset.ts";
import { TEXT_EXTENSIONS, fileExtension } from "~/modules/attachments/constants.ts";
import { parseFileRef } from "./file-ref.ts";
import type { WorkingFiles, WorkingFileRef, WorkingFileSnapshot } from "./working-files.ts";

const tool = Tool.make("publish_file", {
  description:
    "Deliver an exact working-file revision as one final downloadable attachment. Use the working reference returned by an editing tool, or by a tool on the user's computer (a browser screenshot, a file read or imported). An unpublished draft from an editor stays in this chat for a later answer; one from the computer ends with this answer. Neither is delivered until published. Finished one-shot custom exports deliver themselves and do not need this call.",
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

/** What create_file writes: text the model can author whole, never a binary format. */
const CREATABLE = new Set([...Object.keys(TEXT_EXTENSIONS), "svg", "xml", "yaml", "yml"]);
const CREATE_MAX_BYTES = 2 * 1024 * 1024;

const createTool = Tool.make("create_file", {
  description:
    "Write a new text file and deliver it as a downloadable attachment of this answer: CSV, JSON, Markdown, HTML, SVG, XML, YAML, code or plain text. Give its name with the extension and its complete content. For PowerPoint, Excel or Word use those tools; for something the person will keep editing beside the chat, create_document.",
  parameters: Schema.Struct({
    name: advertisedParameter({ type: "string" }),
    content: advertisedParameter({ type: "string" }),
  }),
  success: tool.successSchema,
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
  /** create_file, offered wherever an answer can deliver files at all. */
  readonly createGroup: ToolGroup;
  readonly take: (callId: string) => PendingPublication | undefined;
} {
  const pending = new Map<string, PendingPublication>();
  return {
    // The file is a one-off draft of this answer's, published at once through
    // the same fenced path and budget as publish_file.
    createGroup: {
      family: "tool-file",
      toolkit: Toolkit.make(createTool),
      handlers: {
        create_file: (
          args: { readonly name?: unknown; readonly content?: unknown },
          context: { readonly toolCallId: string },
        ) =>
          Effect.sync(() => {
            const name = typeof args.name === "string" ? args.name.trim() : "";
            if (!name || /[\\/]/.test(name))
              return { ok: false, error: "Give a file name with an extension, without a path." };
            if (!CREATABLE.has(fileExtension(name)))
              return {
                ok: false,
                error:
                  "create_file writes text formats only (such as .csv, .json, .md, .html, .svg). Use the Office tools for .pptx, .xlsx or .docx.",
              };
            if (typeof args.content !== "string" || !args.content)
              return { ok: false, error: "Give the file's complete content." };
            const bytes = new TextEncoder().encode(args.content);
            if (bytes.length > CREATE_MAX_BYTES)
              return { ok: false, error: "The content is larger than 2 MB." };
            try {
              const file = workspace.create({
                name,
                mediaType: fileExtension(name) === "svg" ? "image/svg+xml" : "text/plain",
                bytes,
                owner: "local",
                capture: true,
              });
              const publication = workspace.preparePublish(file.ref);
              if (publication.state === "published")
                return { ok: true, attachmentId: publication.attachmentId };
              pending.set(context.toolCallId, { ref: file.ref, file: publication.file, name });
              return { ok: true, name };
            } catch (cause) {
              return {
                ok: false,
                error: cause instanceof Error ? cause.message : "The file could not be created.",
              };
            }
          }),
      },
    },
    group: {
      family: "tool-file",
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
