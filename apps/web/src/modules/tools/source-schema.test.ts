import { applyToolChunk } from "~/modules/chat/client/use-message-stream.ts";
import { collectSources, prepareCitedMarkdown } from "~/modules/chat/ui/citations.ts";
import {
  KnowledgeActivityResult,
  knowledgeActivityResult,
} from "~/modules/knowledge/tool-schema.ts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { DocumentSource, Source, WebSource } from "./source-schema.ts";
import { documentLocationLabel, isWebSource, mergeSources, sourceTarget } from "./sources.ts";

const document: DocumentSource = {
  kind: "document",
  index: 2,
  title: "Contract",
  snippet: "Clause text",
  read: false,
  collectionId: "collection",
  documentId: "document",
  versionId: "version",
  startOffset: 10,
  endOffset: 50,
  page: 2,
  headingPath: "Terms",
};
const web: WebSource = {
  kind: "web" as const,
  index: 1,
  title: "Website",
  url: "https://example.org",
  snippet: "",
  read: true,
};

describe("document source protocol", () => {
  it("preserves explicit web and document identities on decode", () => {
    const decode = Schema.decodeUnknownSync(Source);
    expect(decode(web)).toEqual(web);
    expect(decode(document)).toEqual(document);
  });

  it.each([
    { ...document, endOffset: 10 },
    { ...document, startOffset: -1 },
    { ...document, versionId: "" },
    { ...document, page: 0 },
    { ...web, kind: "document" },
    { ...web, kind: "unknown" },
    { ...web, kind: undefined },
  ])("refuses malformed document sources instead of falling back to web: %j", (source) => {
    expect(Schema.is(Source)(source)).toBe(false);
  });

  it("does not accept documents in web-only contracts or grant URL authority", () => {
    expect(Schema.is(WebSource)(document)).toBe(false);
    expect([document, web].filter(isWebSource).map((source) => source.url)).toEqual([web.url]);
  });

  it("merges read evidence without dropping version and location metadata", () => {
    const read = { ...document, read: true, snippet: "Read clause" };
    expect(mergeSources([document, read, document])).toEqual([read]);
    expect(mergeSources([read, document])).toEqual([read]);
    expect(mergeSources([read, { ...read, versionId: "other", snippet: "wrong version" }])).toEqual(
      [read],
    );
  });

  it("synthesizes targets from encoded IDs and renders location labels", () => {
    expect(sourceTarget({ ...document, documentId: "doc/?#" })).toBe(
      "/api/knowledge/collection/doc%2F%3F%23/version#range=10-50",
    );
    expect(documentLocationLabel(document)).toBe("Page 2 · Terms");
    expect(documentLocationLabel({ ...document, page: null, headingPath: "" })).toBe(
      "Document excerpt",
    );
  });
});

describe("knowledge citation replay", () => {
  const summary = {
    targets: ["version"],
    documentsListed: 0,
    passagesReturned: 1,
    remainingOps: 63,
    coverage: "Only this excerpt was read.",
  };
  const start = {
    v: 1,
    family: "knowledge",
    phase: "start",
    name: "read_knowledge_document",
    callId: "read",
    turnIndex: 0,
    callIndex: 0,
    textOffset: 4,
  };
  const finish = {
    v: 1,
    family: "knowledge",
    phase: "result",
    name: "read_knowledge_document",
    callId: "read",
    ok: true,
    summary,
    sources: [document],
  };
  it("preserves range identities, offsets and footnote definitions across live replay", () => {
    const pending = applyToolChunk([], JSON.stringify(start));
    const done = applyToolChunk(pending, JSON.stringify(finish));
    expect(done[0]).toMatchObject({
      family: "knowledge",
      textOffset: 4,
      status: "complete",
      sources: [document],
    });
    expect(applyToolChunk(done, JSON.stringify(finish))).toBe(done);
    expect(collectSources(done)).toEqual([document]);
    expect(prepareCitedMarkdown("Claim[^2].", collectSources(done))).toContain(
      "[^2]: /api/knowledge/collection/document/version#range=10-50",
    );
  });
  it("requires the family and refuses malformed document identities", () => {
    expect(applyToolChunk([], JSON.stringify({ ...finish, family: undefined }))).toEqual([]);
    expect(
      applyToolChunk([], JSON.stringify({ ...finish, sources: [{ ...document, versionId: "" }] })),
    ).toEqual([]);
    expect(Schema.is(KnowledgeActivityResult)({ ok: true, summary, sources: [document] })).toBe(
      false,
    );
  });
  it("projects only bounded source metadata and summaries, never raw tool bodies", () => {
    const result = knowledgeActivityResult({
      ok: true,
      targets: [],
      documents: [],
      passages: [],
      sources: [
        { ...document, content: "DO NOT PERSIST", blobKey: "DO NOT PERSIST" } as DocumentSource,
      ],
      failures: [],
      totalCount: 1,
      nextCursor: null,
      remainingOps: 63,
      coverage: "Excerpt only",
    });
    expect(result.sources).toEqual([document]);
    expect(result).not.toHaveProperty("passages");
    expect(JSON.stringify(result)).not.toContain("DO NOT PERSIST");
  });
});
