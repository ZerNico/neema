import { Context, Effect, Layer, type Scope } from "effect";
import { ToolsRepo } from "~/modules/tools/server/repo.ts";
import {
  AiGateway,
  ProviderUnreachable,
  type EmbeddingResult,
} from "~/modules/providers/server/gateway.ts";
import type { ModelNotFound } from "~/modules/chat/errors.ts";
import { makeGenerationCache } from "~/modules/tools/server/generation-cache.ts";
import { KnowledgeNotAvailable, KnowledgeRejected } from "../errors.ts";
import { KNOWLEDGE_LIMITS } from "../schema.ts";
import type { KnowledgePassage, KnowledgeSearchMode } from "../schema.ts";
import { EmbeddingSpace } from "./embedding-space.ts";
import { KnowledgeRepo, type ManifestEntry } from "./repo.ts";

/** Candidates taken from each ranking before fusion. */
const CANDIDATES = 30;
/**
 * Reciprocal-rank fusion constant. 60 is the value the method was published
 * with and behaves well without tuning: it damps the top of each list enough
 * that one ranking cannot dominate the other.
 */
const RRF_K = 60;

export interface KnowledgeSearchResult {
  readonly passages: ReadonlyArray<KnowledgePassage>;
  /** "lexical" means semantic search was off or unavailable for this query. */
  readonly mode: KnowledgeSearchMode;
  /** Set when semantic ranking was expected but could not run. */
  readonly degradedReason: string | null;
}

interface SearchInput {
  query: string;
  limit: number;
}
export interface KnowledgeSearchSession {
  readonly manifest: ReadonlyArray<ManifestEntry>;
  authorize(): Effect.Effect<void, KnowledgeNotAvailable>;
  search(
    input: SearchInput,
  ): Effect.Effect<KnowledgeSearchResult, KnowledgeNotAvailable | KnowledgeRejected>;
}
type EmbedCache = (
  key: string,
  work: Effect.Effect<EmbeddingResult, ProviderUnreachable | ModelNotFound>,
) => Effect.Effect<EmbeddingResult, ProviderUnreachable | ModelNotFound>;

/**
 * Hybrid retrieval over an explicit set of document versions.
 *
 * Every retrieval rechecks access before and after work. Generation sessions
 * additionally pin the selected manifest and cache only query embeddings, never
 * search results or permission decisions.
 *
 * Lexical and semantic candidates are ranked independently and fused, rather
 * than the vector search filtering the keyword hits or vice versa: each finds
 * what the other misses (exact clause numbers and names on one side,
 * paraphrases on the other), and a prefilter would throw that away.
 */
export class KnowledgeSearch extends Context.Service<
  KnowledgeSearch,
  {
    search(
      input: SearchInput & { userId: string; versionIds: ReadonlyArray<string> },
    ): Effect.Effect<KnowledgeSearchResult, KnowledgeNotAvailable | KnowledgeRejected>;
    session(input: {
      userId: string;
      collectionIds: ReadonlyArray<string>;
      manifest: ReadonlyArray<ManifestEntry>;
    }): Effect.Effect<
      KnowledgeSearchSession,
      KnowledgeNotAvailable | KnowledgeRejected,
      Scope.Scope
    >;
  }
>()("chat/knowledge/KnowledgeSearch") {
  static readonly layer = Layer.effect(
    KnowledgeSearch,
    Effect.gen(function* () {
      const repo = yield* KnowledgeRepo;
      const space = yield* EmbeddingSpace;
      const gateway = yield* AiGateway;
      const tools = yield* ToolsRepo;

      const search = Effect.fn("KnowledgeSearch.search")(function* (input: {
        userId: string;
        versionIds: ReadonlyArray<string>;
        query: string;
        limit: number;
        authorize?: () => Effect.Effect<void, KnowledgeNotAvailable>;
        cache?: EmbedCache;
      }) {
        if (
          input.query.length > 500 ||
          !Number.isInteger(input.limit) ||
          input.limit < 1 ||
          input.limit > 20 ||
          input.versionIds.length >
            KNOWLEDGE_LIMITS.maxCollectionsPerSelection * KNOWLEDGE_LIMITS.maxDocumentsPerCollection
        )
          return yield* new KnowledgeRejected({ reason: "knowledge search exceeds input limits" });
        const versionIds = [...new Set(input.versionIds)];
        const authorize =
          input.authorize ?? (() => repo.authorizeVersions(input.userId, versionIds));
        yield* authorize();
        const empty: KnowledgeSearchResult = {
          passages: [],
          mode: "lexical",
          degradedReason: null,
        };
        if (input.versionIds.length === 0 || input.query.trim().length === 0) return empty;

        const lexical = yield* repo.searchLexical(versionIds, input.query, CANDIDATES);

        const target = yield* space.current();
        let semantic: ReadonlyArray<{ chunkId: string; rank: number }> = [];
        let degradedReason: string | null = null;
        let usedSemantic = false;
        const covered = target ? yield* repo.semanticVersionCount(versionIds, target.spaceId) : 0;
        if (target && covered < versionIds.length) {
          degradedReason =
            "semantic indexing is incomplete; keyword search covers the remaining documents";
        } else if (!target && (yield* tools.getTool("knowledge_search")).enabled) {
          degradedReason =
            "semantic search needs an approved, available embedding connection; keyword results only";
        }
        if (target && covered > 0) {
          const request = gateway.embed({
            modelId: target.modelId,
            attribution: { userId: input.userId, kind: "embedding_query" },
            inputs: [input.query],
            expectedDimensions: target.dimensions,
            expectedConnection: target.connection,
            beforeDispatch: () =>
              Effect.gen(function* () {
                yield* authorize();
                const current = yield* space.current();
                if (
                  current?.spaceId !== target.spaceId ||
                  current.connectionRevision !== target.connectionRevision
                )
                  return yield* new ProviderUnreachable({
                    providerId: target.connection.providerId,
                    message: "embedding approval changed before dispatch",
                  });
              }).pipe(
                Effect.mapError(
                  () =>
                    new ProviderUnreachable({
                      providerId: target.connection.providerId,
                      message: "knowledge selection is no longer available",
                    }),
                ),
              ),
          });
          const key = JSON.stringify([
            input.query,
            target.spaceId,
            target.connectionRevision,
            target.modelId,
          ]);
          const embedded = yield* (input.cache ? input.cache(key, request) : request).pipe(
            Effect.result,
          );
          yield* authorize();
          const current = yield* space.current();
          if (
            embedded._tag === "Success" &&
            embedded.success.embeddings[0] &&
            current?.connectionRevision === target.connectionRevision &&
            current.spaceId === target.spaceId
          ) {
            usedSemantic = true;
            semantic = yield* repo.searchSemantic({
              versionIds,
              spaceId: target.spaceId,
              embedding: embedded.success.embeddings[0],
              limit: CANDIDATES,
            });
          } else {
            degradedReason = "semantic search was unavailable, keyword results only";
          }
        }

        const scores = new Map<string, number>();
        for (const ranking of [lexical, semantic]) {
          for (const [position, candidate] of ranking.entries()) {
            scores.set(
              candidate.chunkId,
              (scores.get(candidate.chunkId) ?? 0) + 1 / (RRF_K + position + 1),
            );
          }
        }
        const ordered = [...scores.entries()]
          // oxlint-disable-next-line no-array-sort -- fresh array
          .sort((a, b) => b[1] - a[1])
          .slice(0, input.limit)
          .map(([chunkId]) => chunkId);

        const passages = yield* repo.loadPassages(ordered);
        yield* authorize();
        return {
          passages,
          mode: usedSemantic ? "hybrid" : "lexical",
          degradedReason,
        } satisfies KnowledgeSearchResult;
      });

      return KnowledgeSearch.of({
        search,
        session: Effect.fn("KnowledgeSearch.session")(function* (input) {
          if (
            input.collectionIds.length > KNOWLEDGE_LIMITS.maxCollectionsPerSelection ||
            input.manifest.length >
              KNOWLEDGE_LIMITS.maxCollectionsPerSelection *
                KNOWLEDGE_LIMITS.maxDocumentsPerCollection
          )
            return yield* new KnowledgeRejected({ reason: "knowledge selection exceeds limits" });
          const userId = input.userId;
          const collectionIds = [...new Set(input.collectionIds)];
          const manifest = Object.freeze(
            input.manifest.map((entry) => Object.freeze({ ...entry })),
          );
          let closed = false;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closed = true;
            }),
          );
          const authorize = () =>
            Effect.suspend(() =>
              closed ? Effect.interrupt : repo.authorizeManifest(userId, collectionIds, manifest),
            );
          yield* authorize();
          const cache = yield* makeGenerationCache<
            EmbeddingResult,
            ProviderUnreachable | ModelNotFound
          >({ capacity: 64 });
          const versionIds = manifest.flatMap((entry) =>
            entry.versionId ? [entry.versionId] : [],
          );
          return {
            manifest,
            authorize,
            search: (query) =>
              search({
                ...query,
                userId,
                versionIds,
                authorize,
                cache,
              }),
          } satisfies KnowledgeSearchSession;
        }),
      });
    }),
  );
}
