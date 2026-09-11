import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { computeBudget, estimatePromptTokens } from "~/modules/chat/server/compaction.ts";
import { createSourceIndexer } from "~/modules/tools/server/source-indexer.ts";
import { KnowledgeNotAvailable } from "../errors.ts";
import { KnowledgeActivityResult } from "../tool-schema.ts";
import {
  KNOWLEDGE_SYSTEM_HINT,
  knowledgeContextCeiling,
  prepareKnowledgeContext,
  type KnowledgeContextBudget,
} from "./context.ts";
import type { ManifestEntry } from "./repo.ts";
import type { KnowledgeSearchSession } from "./search.ts";
import { KnowledgeService } from "./service.ts";

const entry = (n: number, chars = 100): ManifestEntry => ({
  collectionId: `collection-${n}`,
  documentId: `document-${n}`,
  versionId: `version-${n}`,
  title: `Document ${n}`,
  charCount: chars,
  status: "ready",
  truncated: false,
});
const base: KnowledgeContextBudget = {
  budget: computeBudget({ contextLength: 64_000, webToolsEnabled: false }),
  baseMessages: [
    { role: "system", content: KNOWLEDGE_SYSTEM_HINT },
    { role: "user", content: "Compare these documents." },
  ],
  toolSchemaTokens: 500,
  toolResultReserveTokens: 6_000,
};
const setup = (
  options: {
    manifest?: ReadonlyArray<ManifestEntry>;
    budget?: Partial<KnowledgeContextBudget>;
    authorize?: KnowledgeSearchSession["authorize"];
    readBodies?: KnowledgeService["Service"]["readBodies"];
    mode?: "context" | "retrieval";
    indexer?: ReturnType<typeof createSourceIndexer>;
  } = {},
) => {
  const manifest = options.manifest ?? [entry(1), entry(2)];
  return prepareKnowledgeContext({
    ...base,
    ...options.budget,
    userId: "actor",
    ...(options.mode ? { mode: options.mode } : {}),
    indexer: options.indexer ?? createSourceIndexer([]),
    session: {
      manifest,
      authorize: options.authorize ?? (() => Effect.void),
      search: () => Effect.die("context preparation must never search or embed"),
    },
  }).pipe(
    Effect.provideService(KnowledgeService, {
      read: () => Effect.die("full context must not loop through range reads"),
      readBodies:
        options.readBodies ??
        ((_actor, references) =>
          Effect.succeed(
            references.map((reference) => ({
              ...reference,
              title: manifest.find((item) => item.versionId === reference.versionId)!.title,
              text: "x".repeat(reference.charCount),
            })),
          )),
    } as unknown as KnowledgeService["Service"]),
  );
};

describe("combined knowledge context", () => {
  it("counts fixed history, real schemas and result reserves against headroom", () => {
    const budget = { context: 10_000, input: 7_000, trigger: 5_000, tail: 2_000 };
    const baseMessages = [{ role: "user" as const, content: "x".repeat(12_000) }];
    expect(
      knowledgeContextCeiling({
        ...base,
        budget,
        baseMessages,
        toolSchemaTokens: 1_000,
        toolResultReserveTokens: 2_000,
      }),
    ).toBe(800);
    const crowded = [{ role: "user" as const, content: "x".repeat(15_000) }];
    expect(
      knowledgeContextCeiling({
        ...base,
        budget,
        baseMessages: crowded,
        toolSchemaTokens: 1_000,
        toolResultReserveTokens: 2_000,
      }),
    ).toBe(242);
    expect(knowledgeContextCeiling({ ...base, toolSchemaTokens: Number.NaN })).toBe(0);
    expect(knowledgeContextCeiling({ ...base, toolResultReserveTokens: -1 })).toBe(0);
  });

  it("uses conservative calibration without allowing a low prior estimate to expand the cap", () => {
    const normal = knowledgeContextCeiling(base);
    expect(
      knowledgeContextCeiling({
        ...base,
        priorUsage: { firstInputTokens: 2_000, estimatedFirstInputTokens: 4_000 },
      }),
    ).toBe(normal);
    const messages = [{ role: "user" as const, content: "x".repeat(100_000) }];
    expect(
      knowledgeContextCeiling({
        ...base,
        baseMessages: messages,
        priorUsage: { firstInputTokens: 8_000, estimatedFirstInputTokens: 4_000 },
      }),
    ).toBe(0);
  });

  it.effect("includes all selected documents with durable citation references", () =>
    Effect.gen(function* () {
      const indexer = createSourceIndexer([
        { kind: "web" as const, index: 7, url: "https://example.com" },
      ]);
      const prepared = yield* setup({ indexer });
      expect(prepared.mode).toBe("context");
      expect(prepared.activity?.sources.map((source) => source.index)).toEqual([8, 9]);
      expect(prepared.activity?.sources[0]).toMatchObject({
        versionId: "version-1",
        startOffset: 0,
        endOffset: 100,
        read: true,
      });
      expect(prepared.messages.map((message) => message.role)).toEqual(["assistant", "user"]);
      expect(prepared.estimatedTokens).toBe(estimatePromptTokens(prepared.messages));
      expect(prepared.estimatedTokens).toBeLessThanOrEqual(knowledgeContextCeiling(base));
      expect(Schema.is(KnowledgeActivityResult)(prepared.activity)).toBe(true);
      expect(prepared.activity).not.toHaveProperty("messages");
      expect(prepared.activity?.sources[0]).not.toHaveProperty("content");
      expect(indexer.indexForDocument(prepared.activity!.sources[0]!)).toBe(8);
    }),
  );

  it.effect("rejects a combined corpus that exceeds the cap before reading any body", () =>
    Effect.gen(function* () {
      let reads = 0;
      const prepared = yield* setup({
        manifest: [entry(1, 20_000), entry(2, 20_000)],
        readBodies: () =>
          Effect.sync(() => {
            reads++;
            throw new Error("must not read");
          }),
      });
      expect(prepared.mode).toBe("retrieval");
      expect(reads).toBe(0);
      expect(prepared.activity).toBeNull();
    }),
  );

  it.effect("never calls partial pending, failed or truncated selections full context", () =>
    Effect.gen(function* () {
      for (const incomplete of [
        { ...entry(2), status: "pending" as const, versionId: null },
        { ...entry(2), status: "failed" as const },
        { ...entry(2), truncated: true },
        { ...entry(2), charCount: null },
      ]) {
        const prepared = yield* setup({
          manifest: [entry(1), incomplete],
          readBodies: () => Effect.die("must not read"),
        });
        expect(prepared.mode).toBe("retrieval");
        expect(prepared.messages[0]?.content).toContain("2 documents");
        expect(prepared.activity).toBeNull();
      }
    }),
  );

  it.effect("falls back to retrieval instead of silently dropping oversized documents", () =>
    Effect.gen(function* () {
      // Retrieval is always available: models without native tool calling
      // are polyfilled in the gateway, so no selection is ever refused here.
      const prepared = yield* setup({
        manifest: [entry(1, 100_000)],
        readBodies: () => Effect.die("must not read"),
      });
      expect(prepared.mode).toBe("retrieval");
      expect(prepared.activity).toBeNull();
    }),
  );

  it.effect("loads all fitting bodies together without range continuations", () =>
    Effect.gen(function* () {
      const batches: number[][] = [];
      const prepared = yield* setup({
        manifest: [entry(1, 24_000), entry(2, 100)],
        readBodies: (_actor, references) => {
          batches.push(references.map((reference) => reference.charCount));
          return Effect.succeed(
            references.map((reference, index) => ({
              ...reference,
              title: `Document ${index + 1}`,
              text: "x".repeat(reference.charCount),
            })),
          );
        },
      });
      expect(prepared.mode).toBe("context");
      expect(batches).toEqual([[24_000, 100]]);
      expect(prepared.activity?.sources[0]).toMatchObject({ startOffset: 0, endOffset: 24_000 });
      expect(prepared.activity?.sources[0]?.snippet).toHaveLength(500);
    }),
  );

  it.effect("discards the whole result when access is revoked during a body read", () =>
    Effect.gen(function* () {
      let authorized = true;
      const indexer = createSourceIndexer([]);
      const result = yield* setup({
        indexer,
        authorize: () =>
          authorized
            ? Effect.void
            : Effect.fail(new KnowledgeNotAvailable({ resourceId: "collection-1" })),
        readBodies: (_actor, references) =>
          Effect.sync(() => {
            authorized = false;
            return references.map((reference, index) => ({
              ...reference,
              title: `Document ${index + 1}`,
              text: "x".repeat(reference.charCount),
            }));
          }),
      }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(indexer.indexFor("https://example.com")).toBe(1);
    }),
  );

  it.effect("does not interpret missing or mismatched immutable content as an excerpt", () =>
    Effect.gen(function* () {
      const result = yield* setup({
        readBodies: (_actor, references) =>
          Effect.succeed(
            references.map((reference) => ({
              ...reference,
              title: "Document 1",
              text: "short",
            })),
          ),
      }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure._tag).toBe("KnowledgeNotAvailable");
    }),
  );

  it.effect("checks encoded bodies, not just raw lengths, before registering citations", () =>
    Effect.gen(function* () {
      const indexer = createSourceIndexer([]);
      const prepared = yield* setup({
        manifest: [entry(1, 10_000)],
        indexer,
        readBodies: (_actor, references) =>
          Effect.succeed(
            references.map((reference) => ({
              ...reference,
              title: "Document 1",
              text: String.fromCharCode(1).repeat(reference.charCount),
            })),
          ),
      });
      expect(prepared.mode).toBe("retrieval");
      expect(prepared.activity).toBeNull();
      expect(indexer.indexFor("https://example.com")).toBe(1);
    }),
  );

  it.effect(
    "keeps retrieval snapshots retrieval and rechecks full-context snapshots against new headroom",
    () =>
      Effect.gen(function* () {
        expect(
          (yield* setup({ mode: "retrieval", readBodies: () => Effect.die("must not read") })).mode,
        ).toBe("retrieval");
        expect(
          (yield* setup({
            mode: "context",
            budget: { baseMessages: [{ role: "user", content: "x".repeat(200_000) }] },
            readBodies: () => Effect.die("must not read"),
          })).mode,
        ).toBe("retrieval");
      }),
  );

  it.effect("treats an empty selected collection honestly and still authorizes it", () =>
    Effect.gen(function* () {
      let authorizations = 0;
      const prepared = yield* setup({
        manifest: [],
        authorize: () =>
          Effect.sync(() => {
            authorizations++;
          }),
      });
      expect(prepared.mode).toBe("context");
      expect(prepared.activity?.sources).toEqual([]);
      expect(prepared.messages[1]?.content).toContain("contain no documents");
      expect(authorizations).toBeGreaterThan(0);
    }),
  );
});
