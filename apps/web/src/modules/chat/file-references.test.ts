import { describe, expect, it } from "vitest";
import {
  attachmentReferenceHint,
  fileReferencesSystemHint,
  isFileReferenceHref,
  localFileName,
  parseFileReference,
  referenceAttachment,
  resolveLocalReference,
} from "./file-references.ts";
import type { Attachment } from "~/modules/attachments/schema.ts";

const file: Attachment = {
  id: "current",
  fileName: "same.txt",
  size: 12,
  mediaType: "text/plain",
  kind: "text",
};

const local = (path: string, overrides = {}) =>
  resolveLocalReference({ path, machineId: "machine", originMachineId: "machine", ...overrides });

describe("file reference destinations", () => {
  it("keeps delivered file replies brief unless the reader wants detail", () => {
    expect(fileReferencesSystemHint).toContain(
      "its preview and download card are already in the answer",
    );
    expect(fileReferencesSystemHint).toContain("unless the reader asks for a breakdown");
  });

  it("uses exact attachment identities and keeps aliases within the current conversation", () => {
    const attachments = new Map([
      [file.id, file],
      ["other", { ...file, id: "other" }],
    ]);
    const aliases = { attachments: { old: "current", missing: "deleted" } };
    expect(referenceAttachment("old", attachments, aliases)).toBe(file);
    expect(referenceAttachment("missing", attachments, aliases)).toBeUndefined();
    expect(referenceAttachment("same.txt", attachments, aliases)).toBeUndefined();
    expect(referenceAttachment("toString", attachments, aliases)).toBeUndefined();
    expect(parseFileReference("/api/files/current")).toEqual({ kind: "attachment", id: "current" });
    expect(attachmentReferenceHint(file)).toContain("/api/files/current");
  });

  it.each([
    "/api/files/x?download=1",
    "/api/files/x/y",
    "/api/files/%2Fother",
    "/api/files/%zz",
    "/local-file?path=relative.txt",
    "/local-file?path=/a&path=/b",
    "/local-file?path=/a#b",
    "/local-file?path=/a&other=x",
    "/local-file?path=/a%zz",
    "/local-file?path=/a%00b",
    "/local-file?path=C:relative.txt",
    "/local-file?path=/a/../b",
    "/local-file?path=/a/./b",
  ])("keeps malformed reserved destinations inert: %s", (href) => {
    expect(isFileReferenceHref(href)).toBe(true);
    expect(parseFileReference(href)).toBeNull();
  });

  it("decodes once and preserves literal percent sequences and query punctuation", () => {
    const path = "/work/雪 (a)#%2F+&.txt";
    expect(parseFileReference(`/local-file?path=${encodeURIComponent(path)}`)).toEqual({
      kind: "local",
      path,
    });
    expect(parseFileReference("/local-file?path=/work/a%252Fb.txt")).toEqual({
      kind: "local",
      path: "/work/a%2Fb.txt",
    });
  });

  it.each(["https://example.com/api/files/id", "file:///work/a", "javascript:alert(1)", "/other"])(
    "does not capture ordinary destinations: %s",
    (href) => {
      expect(isFileReferenceHref(href)).toBe(false);
      expect(parseFileReference(href)).toBeNull();
    },
  );
});

describe("local reference provenance", () => {
  it("opens guest paths of the chat's computer as they are, in every branch", () => {
    expect(local("/workspace/plot.png")).toBe("/workspace/plot.png");
    expect(local("/workspace")).toBe("/workspace");
    expect(local("/folders/site/README.md")).toBe("/folders/site/README.md");
  });

  it("names a local file by its last segment", () => {
    expect(localFileName("/workspace/charts/plot.png")).toBe("plot.png");
    expect(localFileName("/folders/site/README.md")).toBe("README.md");
  });

  it("does not open files from another or unknown machine", () => {
    expect(local("/workspace/a", { originMachineId: "other" })).toBeNull();
    expect(local("/workspace/a", { machineId: null })).toBeNull();
    expect(local("/workspace/a", { originMachineId: null })).toBeNull();
  });

  it("opens nothing outside the computer's roots, host paths included", () => {
    expect(local("/Users/alex/secret.txt")).toBeNull();
    expect(local("C:\\Users\\alex\\secret.txt")).toBeNull();
    expect(local("/folders")).toBeNull();
    expect(local("/workspacex/a")).toBeNull();
  });
});
