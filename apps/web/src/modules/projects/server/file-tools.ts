import { Effect, Option, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { advertisedAs, type ToolGroup } from "~/modules/tools/server/toolset.ts";
import { formatFileRef } from "~/modules/chat/server/file-ref.ts";
import { ProjectFileActivityResult } from "../file-tool-schema.ts";
import type { ProjectFileSummary } from "../files.ts";
import type { ProjectFileConflict, ProjectNotAvailable, ProjectRejected } from "../errors.ts";
import type { ProjectFileService } from "./project-files.ts";
import { EntityId } from "~/entity-id.ts";
import type { DbTx } from "~/server/db.ts";

const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const Version = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const FileEntry = Schema.Struct({
  id: EntityId,
  ref: Schema.String,
  name: Schema.String,
  version: Schema.Int,
  mediaType: Schema.String,
  size: Schema.Int,
  updatedAt: Schema.String,
  updatedBy: Schema.NullOr(Schema.String),
});
const Result = Schema.Struct({
  ...ProjectFileActivityResult.fields,
  files: Schema.optionalKey(Schema.Array(FileEntry)),
  note: Schema.optionalKey(Schema.String),
});
type Result = typeof Result.Type;

const SaveParams = Schema.Struct({
  name: Name,
  chatFile: Schema.optionalKey(Name),
  content: Schema.optionalKey(Schema.String),
  basedOnVersion: Schema.optionalKey(Version),
});

const listTool = Tool.make("list_project_files", {
  description:
    "List the files stored in this chat's project, of any type, with their current version and ref. Loads no content: read_attachment reads one by its ref, and a tool that takes files accepts the ref, id or name.",
  parameters: Tool.EmptyParams,
  success: Result,
});
const saveTool = Tool.make("save_project_file", {
  description:
    "Save a file of any type into this chat's project, where every member sees it. Either chatFile, the id or name of a file in this chat (one the person attached or a tool produced), or content, the full text of a text file such as .md or .csv. name is the file's name in the project: an existing name saves a new version of that file and needs basedOnVersion, the version you last listed or read, or the version a tool reported reading. Binary files come only from chatFile.",
  parameters: Schema.Struct({
    name: advertisedAs(SaveParams.fields.name),
    chatFile: advertisedAs(Name),
    content: advertisedAs(Schema.String),
    basedOnVersion: advertisedAs(Version),
  }),
  success: Result,
});

const entry = (file: ProjectFileSummary): typeof FileEntry.Type => ({
  id: file.id,
  ref: formatFileRef({ kind: "project", id: file.id, version: file.version }),
  name: file.name,
  version: file.version,
  mediaType: file.mediaType,
  size: file.size,
  updatedAt: file.updatedAt,
  updatedBy: file.updatedBy,
});
const failure = (error: ProjectNotAvailable | ProjectRejected | ProjectFileConflict): Result =>
  error._tag === "ProjectNotAvailable"
    ? { outcome: "unavailable", message: "This chat's project is no longer available to you." }
    : {
        outcome: error._tag === "ProjectFileConflict" ? "conflict" : "invalid",
        message: `Not saved: ${error.reason}.`,
      };
const lenient = (raw: unknown) =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== null))
    : raw;

/**
 * Listing and saving a project's files for one answer in a project chat.
 * Reading is `read_attachment`'s, as for any chat file. The row and the
 * stream keep only which file and version, projected where they are written.
 */
export const prepareProjectFileTools = (input: {
  service: Pick<ProjectFileService["Service"], "list" | "write" | "saveAttachment">;
  userId: string;
  conversationId: string;
  generationId: string;
  project: { id: string; canEdit: boolean };
  writeGuard: (tx: DbTx) => Effect.Effect<unknown>;
}) => {
  const { service } = input;
  // The version the model last listed of each file, so a save can default to it.
  const seen = new Map<string, number>();
  const remember = (file: ProjectFileSummary) => seen.set(file.id, file.version);

  const list = Effect.gen(function* () {
    const listed = yield* service.list(input.userId, input.project.id);
    listed.files.forEach(remember);
    return {
      outcome: "listed",
      files: listed.files.map(entry),
      ...(listed.files.length ? {} : { note: "The project has no files yet." }),
    } satisfies Result;
  }).pipe(Effect.catch((error) => Effect.succeed(failure(error))));

  const save = (raw: unknown) =>
    Effect.gen(function* () {
      const params = Schema.decodeUnknownOption(SaveParams)(lenient(raw), {
        onExcessProperty: "ignore",
      });
      if (Option.isNone(params))
        return {
          outcome: "invalid",
          message: "Pass name, and either chatFile or content.",
        } satisfies Result;
      const { name, chatFile, content, basedOnVersion } = params.value;
      if ((chatFile === undefined) === (content === undefined))
        return {
          outcome: "invalid",
          message: "Pass exactly one of chatFile or content.",
        } satisfies Result;
      const existing = (yield* service.list(input.userId, input.project.id)).files.find(
        (file) => file.name === name,
      );
      const based = existing ? (basedOnVersion ?? seen.get(existing.id)) : undefined;
      if (existing && based === undefined)
        return {
          outcome: "conflict",
          fileId: existing.id,
          fileName: existing.name,
          message: `${existing.name} already exists at version ${existing.version}. Read it, then save with basedOnVersion.`,
        } satisfies Result;
      const writer = {
        origin: "model" as const,
        userId: input.userId,
        generationId: input.generationId,
        guard: input.writeGuard,
      };
      const target = {
        projectId: input.project.id,
        fileId: existing?.id,
        basedOnVersion: based,
      };
      const saved =
        content !== undefined
          ? yield* service.write(writer, {
              ...target,
              name,
              bytes: new TextEncoder().encode(content),
            })
          : yield* service.saveAttachment(writer, {
              ...target,
              name,
              attachment: { reference: chatFile! },
              conversationId: input.conversationId,
            });
      remember(saved);
      return {
        outcome: "saved",
        fileId: saved.id,
        fileName: saved.name,
        version: saved.version,
      } satisfies Result;
    }).pipe(Effect.catch((error) => Effect.succeed(failure(error))));

  const bounded = <A>(effect: Effect.Effect<A>) =>
    effect.pipe(
      Effect.catchDefect((defect) =>
        Effect.logError("project file tool failed", {
          conversationId: input.conversationId,
          defect: defect instanceof Error ? `${defect.name}: ${defect.message}` : String(defect),
        }).pipe(Effect.andThen(Effect.die(new Error("Could not use the project's files.")))),
      ),
    );
  return {
    group: input.project.canEdit
      ? ({
          family: "project-file",
          toolkit: Toolkit.make(listTool, saveTool),
          handlers: {
            list_project_files: () => bounded(list),
            save_project_file: (raw: unknown) => bounded(save(raw)),
          },
        } satisfies ToolGroup)
      : ({
          family: "project-file",
          toolkit: Toolkit.make(listTool),
          handlers: {
            list_project_files: () => bounded(list),
          },
        } satisfies ToolGroup),
  };
};
