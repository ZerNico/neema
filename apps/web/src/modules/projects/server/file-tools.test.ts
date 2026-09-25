import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { projectProjectFileResult } from "../file-tool-schema.ts";
import type { ProjectFileSummary } from "../files.ts";
import { ProjectRejected } from "../errors.ts";
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
      list: () => Effect.succeed({ files: [deck], usedBytes: 1000, maxBytes: 10_000 }),
      read: () =>
        Effect.succeed({
          file: deck,
          content: "## Slide 1\nLaunch plan",
          note: "The file's text.",
        }),
      write: (_writer, input) =>
        Effect.gen(function* () {
          writes.push({ basedOnVersion: input.basedOnVersion, fileId: input.fileId });
          if (input.basedOnVersion !== undefined && input.basedOnVersion !== deck.version)
            return yield* new ProjectRejected({
              reason: `the file changed since version ${input.basedOnVersion}`,
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
  it("gives the model a file's text, and the row only which file it was", async () => {
    const { call } = setup();
    const result = await call("read_project_file", { name: "Launch.pptx" });
    expect(result.content).toContain("Launch plan");
    expect(projectProjectFileResult(result)).toEqual({
      outcome: "read",
      fileId: "file-1",
      fileName: "Launch.pptx",
      version: 3,
    });
  });

  it("refuses to overwrite an existing file the model has not seen", async () => {
    const { call, writes } = setup();
    const blind = await call("save_project_file", { name: "Launch.pptx", chatFile: "deck.pptx" });
    expect(blind).toMatchObject({ outcome: "conflict", fileId: "file-1" });
    expect(writes).toEqual([]);
  });

  it("saves over the version it last read, and reports a newer one as a conflict", async () => {
    const { call, writes } = setup();
    await call("read_project_file", { fileId: "file-1" });
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

  it("offers a viewer reading only", () => {
    const { tools } = setup(false);
    expect(Object.keys(tools.group.handlers)).toEqual(["list_project_files", "read_project_file"]);
  });
});
