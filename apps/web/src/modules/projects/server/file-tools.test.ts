import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { projectProjectFileResult } from "../file-tool-schema.ts";
import type { ProjectFileSummary } from "../files.ts";
import { ProjectFileConflict } from "../errors.ts";
import { prepareProjectFileTools } from "./file-tools.ts";

const deck: ProjectFileSummary = {
  id: "file-1",
  name: "Launch.pptx",
  version: 3,
  versionId: "version-3",
  mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  size: 1000,
  updatedAt: new Date(0).toISOString(),
  updatedBy: "Ada",
  origin: "user",
  versionCount: 3,
};

function setup(canEdit = true) {
  const writes: Array<{ basedOnVersion: number | undefined; fileId: string | undefined }> = [];
  const tools = prepareProjectFileTools({
    service: {
      list: () => Effect.succeed({ files: [deck], usedBytes: 1000 }),
      write: (_writer, input) =>
        Effect.gen(function* () {
          writes.push({ basedOnVersion: input.basedOnVersion, fileId: input.fileId });
          if (input.basedOnVersion !== undefined && input.basedOnVersion !== deck.version)
            return yield* new ProjectFileConflict({
              basedOnVersion: input.basedOnVersion,
              current: deck.version,
            });
          return { ...deck, id: input.fileId ?? "file-2", name: input.name, version: 4 };
        }),
      saveAttachment: (_writer, input) =>
        Effect.succeed({ ...deck, name: input.name ?? deck.name, version: 4 }),
    },
    userId: "user-1",
    conversationId: "chat-1",
    generationId: "gen-1",
    project: { id: "project-1", canEdit },
    writeGuard: () => Effect.void,
  });
  const call = (name: string, raw: unknown = {}) =>
    Effect.runPromise(
      (tools.group.handlers as Record<string, (raw: unknown) => Effect.Effect<unknown>>)[name]!(
        raw,
      ),
    ) as Promise<Record<string, unknown>>;
  return { tools, call, writes };
}

describe("project file tools", () => {
  it("lists each file with the ref read_attachment reads, and the row only that it listed", async () => {
    const { call } = setup();
    const result = await call("list_project_files");
    expect(result.files).toEqual([
      expect.objectContaining({ id: "file-1", ref: "project:file-1@3", version: 3 }),
    ]);
    expect(projectProjectFileResult(result)).toEqual({ outcome: "listed" });
  });

  it("refuses to overwrite an existing file the model has not seen", async () => {
    const { call, writes } = setup();
    const blind = await call("save_project_file", { name: "Launch.pptx", chatFile: "deck.pptx" });
    expect(blind).toMatchObject({ outcome: "conflict", fileId: "file-1" });
    expect(writes).toEqual([]);
  });

  it("saves over the version it last listed, and reports a newer one as a conflict", async () => {
    const { call, writes } = setup();
    await call("list_project_files");
    const saved = await call("save_project_file", { name: "Launch.pptx", content: "text" });
    expect(saved).toMatchObject({ outcome: "saved", version: 4 });
    expect(writes).toEqual([{ basedOnVersion: 3, fileId: "file-1" }]);
    const stale = await call("save_project_file", {
      name: "Launch.pptx",
      content: "text",
      basedOnVersion: 2,
    });
    expect(stale).toMatchObject({ outcome: "conflict" });
  });

  it("needs exactly one source for a save", async () => {
    const { call } = setup();
    expect(await call("save_project_file", { name: "notes.md" })).toMatchObject({
      outcome: "invalid",
    });
    expect(
      await call("save_project_file", { name: "notes.md", content: "a", chatFile: "b.md" }),
    ).toMatchObject({ outcome: "invalid" });
  });

  it("offers a viewer listing only", () => {
    const { tools } = setup(false);
    expect(Object.keys(tools.group.handlers)).toEqual(["list_project_files"]);
  });
});
