import { describe, expect, it } from "vitest";
import { splitFinding } from "./finding.ts";

describe("splitFinding", () => {
  it("takes the finding line off the report and leaves the evidence whole", () => {
    expect(
      splitFinding("Finding: Das SBGG ändert nichts an der Kostenübernahme[^3].\n\nEvidence[^3]."),
    ).toEqual({
      report: "Evidence[^3].",
      finding: "Das SBGG ändert nichts an der Kostenübernahme.",
    });
  });

  it("reads a finding written after a preamble, in plain words", () => {
    expect(splitFinding("Report\n**Finding:** _Two_ clinics   take new patients.\nMore")).toEqual({
      report: "Report\n\nMore",
      finding: "Two clinics take new patients.",
    });
  });

  it("shows nothing when the task established nothing or wrote no line", () => {
    expect(splitFinding("Finding: none\nNo usable evidence.")).toEqual({
      report: "No usable evidence.",
    });
    expect(splitFinding("Only evidence[^1].")).toEqual({ report: "Only evidence[^1]." });
  });

  it("caps a finding that runs long", () => {
    const finding = splitFinding(`Finding: ${"word ".repeat(100)}`).finding!;
    expect(finding.length).toBe(240);
    expect(finding.endsWith("…")).toBe(true);
  });
});
