import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Schema, Stream } from "effect";
import { Tool } from "effect/unstable/ai";
import { mergeToolGroups } from "~/modules/tools/server/toolset.ts";
import { createSourceIndexer } from "~/modules/tools/server/source-indexer.ts";
import { KnowledgeNotAvailable } from "../errors.ts";
import {
  KNOWLEDGE_TOOL_LIMITS,
  KnowledgeToolResult,
  projectKnowledgeToolResult,
  summarizeKnowledgeResult,
} from "../tool-schema.ts";
import type { ManifestEntry } from "./repo.ts";
import type { KnowledgeSearchSession } from "./search.ts";
import { KnowledgeService, type DocumentExcerpt } from "./service.ts";
import { knowledgeResultTokens, prepareKnowledgeTools, searchKnowledgeTool } from "./tools.ts";

const entry = (number: number): ManifestEntry => ({
  collectionId: "collection",
  documentId: `document-${number}`,
  versionId: `version-${number}`,
  title: `Document ${number}`,
  status: "ready",
  charCount: 20_000,
  truncated: false,
});
const setup = (
  options: {
    manifest?: ReadonlyArray<ManifestEntry>;
    authorize?: KnowledgeSearchSession["authorize"];
    search?: KnowledgeSearchSession["search"];
    read?: KnowledgeService["Service"]["read"];
  } = {},
) =>
  prepareKnowledgeTools({
    userId: "actor",
    indexer: createSourceIndexer([]),
    session: {
      manifest: options.manifest ?? [entry(1), entry(2)],
      authorize: options.authorize ?? (() => Effect.void),
      search:
        options.search ??
        (() => Effect.succeed({ mode: "lexical", degradedReason: null, passages: [] })),
    },
  }).pipe(
    Effect.provideService(KnowledgeService, {
      read:
        options.read ??
        ((_actor, input) =>
          Effect.succeed({
            ...input,
            title: "Document",
            content: "x".repeat(Math.min(input.maxChars, 20_000 - input.startOffset)),
            endOffset: Math.min(20_000, input.startOffset + input.maxChars),
            totalChars: 20_000,
            nextOffset: Math.min(20_000, input.startOffset + input.maxChars),
          } satisfies DocumentExcerpt)),
    } as KnowledgeService["Service"]),
  );
const request = (n: number, maxChars = 100) => ({
  documentId: `document-${n}`,
  versionId: `version-${n}`,
  startOffset: 0,
  maxChars,
});

describe("selected knowledge tools", () => {
  it.effect(
    "pages the frozen manifest, including pending entries, with generation-bound cursors",
    () =>
      Effect.gen(function* () {
        const manifest = [
          ...Array.from({ length: 24 }, (_, i) => entry(i)),
          { ...entry(24), versionId: null, status: "pending" as const },
        ];
        const first = yield* setup({ manifest });
        const handlers = first.group.handlers;
        const page = yield* handlers.list_knowledge_documents({});
        expect(page.documents).toHaveLength(20);
        expect(page.totalCount).toBe(25);
        const last = yield* handlers.list_knowledge_documents({ cursor: page.nextCursor! });
        expect(last.documents).toHaveLength(5);
        expect(last.documents[4]).toMatchObject({ status: "pending", versionId: null });
        expect(last.nextCursor).toBeNull();
        const second = yield* setup({ manifest });
        expect(
          (yield* second.group.handlers.list_knowledge_documents({ cursor: page.nextCursor! })).ok,
        ).toBe(false);
        expect(knowledgeResultTokens(page)).toBeLessThan(KNOWLEDGE_TOOL_LIMITS.resultTokens);
      }),
  );

  it.effect("checks the whole read selection before retrieving any body", () =>
    Effect.gen(function* () {
      let reads = 0;
      const tools = yield* setup({
        read: () =>
          Effect.sync(() => {
            reads++;
            throw new Error("must not read");
          }),
      });
      const result = yield* tools.group.handlers.read_knowledge_document({
        documents: [request(1), { ...request(2), versionId: "guessed" }],
      });
      expect(result.ok).toBe(false);
      expect(result.error).toBe("document is not in the selected manifest");
      expect(reads).toBe(0);
      expect(result.passages).toEqual([]);
    }),
  );

  it.effect(
    "bounds combined reads, supplies exact continuations, and keeps bodies out of persisted summaries",
    () =>
      Effect.gen(function* () {
        const tools = yield* setup();
        const result = yield* tools.group.handlers.read_knowledge_document({
          documents: [request(1, 16_000), request(2, 16_000)],
        });
        expect(result.passages).toHaveLength(1);
        expect(result.passages[0]?.content).toHaveLength(16_000);
        expect(result.passages[0]?.nextOffset).toBe(16_000);
        expect(result.sources[0]).toMatchObject({ startOffset: 0, endOffset: 16_000, read: true });
        expect(result.failures).toEqual([
          { target: "version-2", error: expect.stringContaining("Batch character limit") },
        ]);
        expect(knowledgeResultTokens(result)).toBeLessThanOrEqual(
          KNOWLEDGE_TOOL_LIMITS.resultTokens,
        );
        const durable = summarizeKnowledgeResult(result);
        expect(durable.passagesReturned).toBe(1);
        expect(durable).not.toHaveProperty("passages");
        expect(JSON.stringify(durable)).not.toContain("xxxxxxxx");
        expect(Schema.is(KnowledgeToolResult)(result)).toBe(true);
        const activity = projectKnowledgeToolResult(result, false, 63);
        expect(activity).toMatchObject({ family: "knowledge", ok: true, summary: durable });
        expect(activity).not.toHaveProperty("passages");
        expect(activity.sources[0]!.snippet).toHaveLength(500);
        expect(JSON.stringify(activity)).not.toContain("x".repeat(501));
        for (const rejected of [
          projectKnowledgeToolResult(result, true, 63),
          projectKnowledgeToolResult({ passages: ["private body"] }, false, 63),
        ]) {
          expect(rejected).toMatchObject({
            ok: false,
            sources: [],
            error: "knowledge tool failed",
            summary: { remainingOps: 63 },
          });
          expect(JSON.stringify(rejected)).not.toContain("private body");
          expect(JSON.stringify(rejected)).not.toContain("xxxxxxxx");
        }
      }),
  );

  it.effect("fits escaped content against the complete result token budget", () =>
    Effect.gen(function* () {
      const tools = yield* setup({
        read: (_actor, input) =>
          Effect.succeed({
            ...input,
            title: "Escaped",
            content: String.fromCharCode(1).repeat(input.maxChars),
            endOffset: input.maxChars,
            totalChars: 20_000,
            nextOffset: input.maxChars,
          }),
      });
      const result = yield* tools.group.handlers.read_knowledge_document({
        documents: [request(1, 16_000)],
      });
      expect(result.passages[0]!.content.length).toBeGreaterThan(0);
      expect(result.passages[0]!.content.length).toBeLessThan(16_000);
      expect(result.sources[0]!.endOffset).toBe(result.passages[0]!.content.length);
      expect(result.passages[0]!.nextOffset).toBe(result.sources[0]!.endOffset);
      expect(knowledgeResultTokens(result)).toBeLessThanOrEqual(KNOWLEDGE_TOOL_LIMITS.resultTokens);
    }),
  );

  it.effect("reports keyword-only search and never embeds raw bodies in document sources", () =>
    Effect.gen(function* () {
      const tools = yield* setup({
        search: () =>
          Effect.succeed({
            mode: "lexical",
            degradedReason: "Semantic search unavailable.",
            passages: [
              {
                collectionId: "collection",
                documentId: "document-1",
                versionId: "version-1",
                chunkId: "chunk",
                title: "Contract",
                headingPath: "Terms",
                page: 1,
                startOffset: 5,
                endOffset: 1010,
                content: "a".repeat(1005),
              },
            ],
          }),
      });
      const result = yield* tools.group.handlers.search_knowledge({ queries: ["clause"] });
      expect(result.mode).toBe("lexical");
      expect(result.degradedReason).toBe("Semantic search unavailable.");
      // A hit is a bounded excerpt of its chunk, so twelve of them fit one
      // result; the exact range is what read_knowledge_document continues from.
      expect(result.sources[0]).toMatchObject({
        kind: "document",
        read: false,
        startOffset: 5,
        endOffset: 5 + KNOWLEDGE_TOOL_LIMITS.searchExcerptChars,
      });
      expect(result.passages[0]!.nextOffset).toBe(5 + KNOWLEDGE_TOOL_LIMITS.searchExcerptChars);
      expect(result.sources[0]).not.toHaveProperty("content");
      expect(result.sources[0]).not.toHaveProperty("chunkId");
      expect(result.sources[0]!.snippet).toHaveLength(500);
      expect(
        (yield* tools.group.handlers.search_knowledge({ queries: ["same"] })).sources[0]!.index,
      ).toBe(result.sources[0]!.index);
    }),
  );

  it.effect("answers a call past its limits with what was wrong, through the toolkit", () =>
    Effect.gen(function* () {
      const tools = yield* setup();
      const toolkit = (yield* mergeToolGroups([tools.group]))!;
      const stream = yield* toolkit.handle("search_knowledge", {
        queries: ["one", "two", "three", "four"],
      }) as Effect.Effect<Stream.Stream<{ result: unknown }, unknown, unknown>, unknown, never>;
      const narrowed = stream as Stream.Stream<{ result: unknown }, unknown, never>;
      const result = [...(yield* Stream.runCollect(narrowed))].at(-1)!
        .result as KnowledgeToolResult;
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/invalid knowledge tool arguments: .*at most 3/);
      expect(tools.remaining()).toBe(KNOWLEDGE_TOOL_LIMITS.operations);
      expect(Tool.getJsonSchema(searchKnowledgeTool)).toMatchObject({
        properties: { queries: { type: "array", maxItems: 3 } },
      });
    }),
  );

  it.effect("shares one hard operation budget and refuses further backend work", () =>
    Effect.gen(function* () {
      let searches = 0;
      const tools = yield* setup({
        search: () =>
          Effect.sync(() => {
            searches++;
            return { mode: "lexical" as const, degradedReason: null, passages: [] };
          }),
      });
      for (let i = 0; i < 63; i++) yield* tools.group.handlers.list_knowledge_documents({});
      const refused = yield* tools.group.handlers.search_knowledge({ queries: ["one", "two"] });
      expect(refused.ok).toBe(false);
      expect(tools.remaining()).toBe(0);
      expect(searches).toBe(0);
      expect((yield* tools.group.handlers.search_knowledge({ queries: ["one"] })).ok).toBe(false);
      expect(searches).toBe(0);
    }),
  );

  it.effect("reauthorizes after slow reads and discards the entire revoked result", () =>
    Effect.gen(function* () {
      let allowed = true;
      const tools = yield* setup({
        authorize: () =>
          allowed
            ? Effect.void
            : Effect.fail(new KnowledgeNotAvailable({ resourceId: "collection" })),
        read: (_actor, input) =>
          Effect.sync(() => {
            allowed = false;
            return {
              ...input,
              title: "Private",
              content: "private body",
              endOffset: 12,
              totalChars: 12,
              nextOffset: null,
            };
          }),
      });
      const result = yield* tools.group.handlers
        .read_knowledge_document({ documents: [request(1)] })
        .pipe(Effect.result);
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "KnowledgeNotAvailable" } });
      expect(JSON.stringify(result)).not.toContain("private body");
      allowed = true;
      expect(yield* tools.authorize().pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "KnowledgeNotAvailable" },
      });
    }),
  );

  it.effect("reauthorizes queued operations after the shared three-operation permit", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let calls = 0;
      let allowed = true;
      const tools = yield* setup({
        authorize: () =>
          allowed
            ? Effect.void
            : Effect.fail(new KnowledgeNotAvailable({ resourceId: "collection" })),
        search: () =>
          Effect.gen(function* () {
            calls++;
            if (calls === 3) yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return { mode: "lexical" as const, degradedReason: null, passages: [] };
          }),
      });
      const workers = yield* Effect.forEach([1, 2, 3], () =>
        tools.group.handlers
          .search_knowledge({ queries: ["query"] })
          .pipe(Effect.result, Effect.forkScoped),
      );
      yield* Deferred.await(started);
      const queued = yield* tools.group.handlers
        .search_knowledge({ queries: ["fourth"] })
        .pipe(Effect.result, Effect.forkScoped);
      allowed = false;
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(queued)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "KnowledgeNotAvailable" },
      });
      yield* Effect.forEach(workers, Fiber.join);
      expect(calls).toBe(3);
    }).pipe(Effect.scoped),
  );
});
