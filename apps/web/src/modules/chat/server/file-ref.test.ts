import { describe, expect, it } from "vitest";
import { formatFileRef, parseFileRef } from "./file-ref.ts";

const revision = "01990f4e-6650-7a33-a768-611e2e4bf4c7";

describe("file references", () => {
  it("round trips a skill file at its exact revision, nested path included", () => {
    const ref = {
      kind: "skill",
      revisionId: revision,
      path: "assets/brand/master deck.pptx",
    } as const;
    expect(formatFileRef(ref)).toBe(`skill:${revision}/assets/brand/master deck.pptx`);
    expect(parseFileRef(formatFileRef(ref))).toEqual(ref);
  });

  it.each([
    `skill:${revision}/`,
    `skill:${revision}/../SKILL.md`,
    `skill:${revision}//a.pptx`,
    `skill:${revision}/a\\b.pptx`,
    "skill:not-a-revision/a.pptx",
  ])("refuses a skill reference that is not an exact safe path: %s", (raw) => {
    expect(parseFileRef(raw)).toBeUndefined();
  });

  it("keeps the other kinds unchanged", () => {
    expect(parseFileRef(`attachment:${revision}`)).toEqual({ kind: "attachment", id: revision });
    expect(parseFileRef(`working:${revision}@3`)).toEqual({
      kind: "working",
      id: revision,
      revision: 3,
    });
  });
});
