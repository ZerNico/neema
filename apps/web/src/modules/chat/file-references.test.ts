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
  resolveLocalReference({
    path,
    conversationId: "branch",
    workspaceRoot: "/profile/workspaces/branch",
    workspaceAncestors: ["source", "original"],
    machineId: "machine",
    originMachineId: "machine",
    ...overrides,
  });

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
    const aliases = { attachments: { old: "current", missing: "deleted" }, workspaceAncestors: [] };
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
  it("relocates only exact recorded workspace ancestors", () => {
    expect(local("/profile/workspaces/source/downloaded_images/image_0.jpg")).toBe(
      "/profile/workspaces/branch/downloaded_images/image_0.jpg",
    );
    expect(local("/profile/workspaces/original/image.jpg")).toBe(
      "/profile/workspaces/branch/image.jpg",
    );
    expect(local("/profile/workspaces/branch/image.jpg")).toBe(
      "/profile/workspaces/branch/image.jpg",
    );
    expect(local("/profile/workspaces/stranger/image.jpg")).toBe(
      "/profile/workspaces/stranger/image.jpg",
    );
    expect(local("/profile/workspaces/source-other/image.jpg")).toBe(
      "/profile/workspaces/source-other/image.jpg",
    );
    expect(local("/attached/source/image.jpg")).toBe("/attached/source/image.jpg");
  });

  it("does not open files from another or unknown machine", () => {
    expect(local("/work/a", { originMachineId: "other" })).toBeNull();
    expect(local("/work/a", { machineId: null })).toBeNull();
    expect(local("/work/a", { originMachineId: null })).toBeNull();
  });

  it("handles Windows drives and UNC paths independently of the server platform", () => {
    expect(local("C:\\profile\\source\\image.jpg", { workspaceRoot: "C:\\profile\\branch" })).toBe(
      "C:/profile/branch/image.jpg",
    );
    expect(local("c:/profile/source/image.jpg", { workspaceRoot: "C:\\profile\\branch" })).toBe(
      "C:/profile/branch/image.jpg",
    );
    expect(
      local("\\\\server\\share\\source\\image.jpg", { workspaceRoot: "\\\\server\\share\\branch" }),
    ).toBe("//server/share/branch/image.jpg");
    expect(localFileName("C:\\attached\\a.txt")).toBe("a.txt");
    expect(localFileName("/attached/a\\b.txt")).toBe("a\\b.txt");
  });

  it("waits for a valid current workspace rather than falling back to the source", () => {
    expect(local("/profile/workspaces/source/image.jpg", { workspaceRoot: null })).toBeNull();
    expect(
      local("/profile/workspaces/source/image.jpg", { workspaceRoot: "/wrong/layout" }),
    ).toBeNull();
    expect(local("//server/share/source/a.png", { workspaceRoot: "//server/share/branch" })).toBe(
      "//server/share/branch/a.png",
    );
  });

  it("does not normalize traversal past the desktop symlink check", () => {
    expect(local("/profile/workspaces/source/link/../secret")).toBeNull();
    expect(local("C:\\profile\\source\\..\\secret")).toBeNull();
  });
});
