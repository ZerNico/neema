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
  it("takes each family whole from one source: an upload, else a loaded skill, else Google", () => {
    const chosen = withFaces(
      [
        face("google"),
        face("google", "Poppins", true),
        face("upload", "Inter"),
        face("google", "Lato"),
        face("google", "Lato", true),
      ],
      [face("skill"), face("skill", "Inter", true)],
    );
    // Google's Poppins Bold is dropped beside the skill's Regular, and the
    // skill's Inter Bold beside the upload's Regular: no family mixes designs.
    expect(chosen.map((f) => `${f.family}/${f.bold}/${f.source}`).toSorted()).toEqual([
      "Inter/false/upload",
      "Lato/false/google",
      "Lato/true/google",
      "Poppins/false/skill",
    ]);
  });
});
