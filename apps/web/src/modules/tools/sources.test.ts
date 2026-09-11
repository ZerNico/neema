import { describe, expect, it } from "vitest";
import type { Source } from "./schema.ts";
import { mergeSources } from "./sources.ts";

const hit: Source = {
  kind: "web" as const,
  index: 1,
  url: "https://a.example",
  title: "Search title",
  snippet: "Search snippet",
  read: false,
};
const extracted: Source = { ...hit, title: "Page title", snippet: "Page excerpt", read: true };

describe("source observations", () => {
  it.each([
    [hit, extracted, hit],
    [extracted, hit, hit],
    [hit, hit, extracted],
  ])("preserves extraction across search/read ordering: %j", (...observations) => {
    expect(mergeSources(observations)).toEqual([extracted]);
  });

  it("has deterministic metadata and index order across equal-provenance observations", () => {
    const other = { ...hit, title: "A useful longer title", snippet: "B" };
    const second = { ...extracted, index: 2, url: "https://b.example" };
    expect(mergeSources([hit, other, second])).toEqual(mergeSources([second, other, hit]));
    expect(mergeSources([hit, other, second]).map((source) => source.index)).toEqual([1, 2]);
    expect(mergeSources([hit, other])[0]?.title).toBe(other.title);
  });
});
