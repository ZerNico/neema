import { describe, expect, it } from "vitest";
import { createSourceIndexer } from "./source-indexer.ts";
import { sourceTarget } from "../sources.ts";

const location = {
  collectionId: "collection",
  documentId: "document",
  versionId: "version",
  startOffset: 0,
  endOffset: 100,
};

describe("conversation source identities", () => {
  it("shares one sequence without conflating document locations and web URLs", () => {
    const indexer = createSourceIndexer([
      { kind: "web" as const, index: 3, url: "https://example.org/page#old" },
    ]);
    expect(indexer.indexFor("https://example.org/page#new")).toBe(3);
    expect(indexer.indexForDocument(location)).toBe(4);
    expect(indexer.indexForDocument({ ...location })).toBe(4);
    expect(indexer.indexForDocument({ ...location, versionId: "replacement" })).toBe(5);
    expect(indexer.indexForDocument({ ...location, startOffset: 50 })).toBe(6);
    expect(indexer.indexFor(sourceTarget({ ...location, kind: "document" }))).toBe(7);
  });

  it("seeds old document references and keeps the first handle for duplicate web identities", () => {
    const indexer = createSourceIndexer([
      { ...location, kind: "document", index: 8 },
      { kind: "web" as const, url: "https://example.org/#a", index: 2 },
      { kind: "web" as const, url: "https://example.org/#b", index: 9 },
    ]);
    expect(indexer.indexForDocument(location)).toBe(8);
    expect(indexer.indexFor("https://example.org/")).toBe(2);
    expect(indexer.indexFor("https://new.example.org/")).toBe(10);
  });
});
