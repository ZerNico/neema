import { describe, expect, it } from "vitest";
import type { FontFace } from "./font-file.ts";
import { withFaces } from "./processor.ts";

const face = (source: FontFace["source"], family = "Poppins", bold = false): FontFace => ({
  family,
  renderFamily: family,
  bold,
  italic: false,
  path: `/${source}/${family}-${bold}.ttf`,
  source,
});

describe("faces a job draws with", () => {
  it("keeps one per family and style: an upload, then a loaded skill's, then a fetched one", () => {
    const chosen = withFaces(
      [face("google"), face("google", "Poppins", true), face("upload", "Inter")],
      [face("skill"), face("skill", "Inter")],
    );
    expect(chosen.map((f) => `${f.family}/${f.bold}/${f.source}`).toSorted()).toEqual([
      "Inter/false/upload",
      "Poppins/false/skill",
      "Poppins/true/google",
    ]);
  });
});
