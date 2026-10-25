import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { AttachmentWithBlob } from "~/modules/attachments/server/repo.ts";
import { attachmentReadActivity, prepareAttachmentReader, readText } from "./attachment-reader.ts";
import { fitFileText, inlineTextCharsFor } from "./prompt.ts";

const text = Array.from({ length: 400 }, (_, i) => `row ${i},value ${i * 2}`).join("\n");

describe("read_attachment", () => {
  it("pages through a range and says where to continue", () => {
    const first = readText(text, { offset: 0, length: 100 });
    expect(first).toMatchObject({ mode: "range", from: 0, to: 100, total: text.length });
    expect(first.content).toBe(text.slice(0, 100));
    expect(first.nextOffset).toBe(100);
    expect(readText(text, { offset: text.length - 5 }).nextOffset).toBeNull();
    // Garbage paging falls back instead of failing.
    expect(readText(text, { offset: -4, length: "x" })).toMatchObject({ from: 0 });
  });

  it("lists matching lines with their offsets, case-insensitively", () => {
    const found = readText(text, { pattern: "ROW 12," });
    expect(found).toMatchObject({ mode: "search", matches: 1 });
    expect(found.content).toBe(`line 13, offset ${text.indexOf("row 12,")}: row 12,value 24`);
    expect(readText(text, { pattern: "missing" }).content).toBe("No line contains that text.");
  });

  it("reads only this conversation's files and keeps the text out of the durable row", async () => {
    const row = {
      id: "att-1",
      fileName: "data.csv",
      blobId: "blob-1",
      storageKey: "key",
      mediaType: "text/plain",
    } as AttachmentWithBlob;
    const reader = prepareAttachmentReader({
      deps: {
        store: { get: () => Effect.succeed(new TextEncoder().encode(text)) },
        parser: {} as never,
      },
      owner: "user-1",
      find: (id) => Effect.succeed(id === row.id ? row : null),
    });
    const read = reader.group.handlers["read_attachment"] as (
      args: unknown,
    ) => Effect.Effect<unknown>;
    expect(await Effect.runPromise(read({ attachmentId: "elsewhere" }))).toMatchObject({
      ok: false,
    });
    const result = await Effect.runPromise(read({ attachmentId: "att-1", length: 10 }));
    expect(result).toMatchObject({ ok: true, fileName: "data.csv", content: text.slice(0, 10) });
    expect(attachmentReadActivity(result)).not.toHaveProperty("content");
  });

  it("reads a project file the same way, and holds an image for the model's next round", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const projectFile = (name: string, mediaType: string, bytes: Uint8Array) => ({
      name,
      mediaType,
      bytes,
      source: { kind: "project" as const, fileId: "file-1", version: 2 },
      ref: { kind: "project" as const, id: "file-1", version: 2 },
    });
    const reader = prepareAttachmentReader({
      deps: { store: {} as never, parser: {} as never },
      owner: "user-1",
      find: () => Effect.succeed(null),
      project: (reference) =>
        reference === "notes.md"
          ? Effect.succeed(projectFile("notes.md", "text/plain", new TextEncoder().encode(text)))
          : reference === "logo.png"
            ? Effect.succeed(projectFile("logo.png", "image/png", png))
            : reference === "tool.exe"
              ? Effect.succeed(
                  projectFile("tool.exe", "application/octet-stream", new Uint8Array([0x4d])),
                )
              : Effect.fail("No file in this chat or its project."),
    });
    const read = reader.group.handlers["read_attachment"] as (
      args: unknown,
      context: { toolCallId: string },
    ) => Effect.Effect<unknown>;
    const run = (args: unknown, toolCallId = "call-1") =>
      Effect.runPromise(read(args, { toolCallId }));
    expect(await run({ attachmentId: "notes.md", offset: 100, length: 50 })).toMatchObject({
      ok: true,
      fileName: "notes.md",
      content: text.slice(100, 150),
      nextOffset: 150,
    });
    expect(await run({ attachmentId: "gone.md" })).toEqual({
      ok: false,
      error: "No file in this chat or its project.",
    });
    expect(await run({ attachmentId: "tool.exe" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("a tool that takes files"),
    });
    expect(await run({ attachmentId: "logo.png" }, "call-2")).toMatchObject({ ok: true });
    expect(reader.takeShown("call-2")).toMatchObject({
      id: "project:file-1@2",
      fileName: "logo.png",
      mediaType: "image/png",
      bytes: png,
    });
    expect(reader.takeShown("call-2")).toBeUndefined();
  });
});

describe("inlining a long file", () => {
  it("keeps its start and end and names the way to the rest", () => {
    const fitted = fitFileText(text, 1_000, { id: "att-1" });
    expect(fitted.length).toBeLessThan(1_300);
    expect(fitted.startsWith(text.slice(0, 700))).toBe(true);
    expect(fitted.endsWith(text.slice(-300))).toBe(true);
    expect(fitted).toContain('read_attachment with attachment id "att-1"');
    expect(fitFileText("short", 1_000, { id: "x" })).toBe("short");
  });

  it("caps at a quarter of a small window and 60k characters on a large one", () => {
    expect(inlineTextCharsFor(8_000)).toBe(8_000);
    expect(inlineTextCharsFor(1_000_000)).toBe(60_000);
  });
});
