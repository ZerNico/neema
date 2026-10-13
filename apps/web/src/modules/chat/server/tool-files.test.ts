import { describe, expect, it } from "vitest";
import { fromFilePath } from "./tool-files.ts";

describe("fromFilePath", () => {
  const id = "0199b2f1-0000-7000-8000-000000000001";

  it("reads the app's file link as the attachment it names", () => {
    expect(fromFilePath(`/api/files/${id}`)).toBe(`attachment:${id}`);
    expect(fromFilePath(`https://chat.example.com/api/files/${id.toUpperCase()}`)).toBe(
      `attachment:${id}`,
    );
  });

  it("leaves ids, names and other links as they are", () => {
    for (const reference of [id, "photo.png", `/api/files/${id}/extra`, `/api/other/${id}`])
      expect(fromFilePath(reference)).toBe(reference);
  });
});
