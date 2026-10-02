import { and, eq, ne } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";
import { Db } from "~/server/db.ts";
import { tools } from "~/db/schema/index.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { KnowledgeSearchConfig } from "~/modules/knowledge/schema.ts";
import { DocumentParserConfig, UrlReaderConfig, WebSearchConfig } from "../schema.ts";
import { loadEnabledSearchProviders } from "./search-provider-repo.ts";
import type { SearchProviderSnapshot } from "./search-providers/types.ts";

type ToolRow = typeof tools.$inferSelect;
/**
 * Tool rows safe for admin clients: ciphertext replaced by a boolean.
 */
export type PublicTool = Omit<ToolRow, "secretCiphertext"> & { secretConfigured: boolean };

const toPublic = ({ secretCiphertext, ...rest }: ToolRow): PublicTool => ({
  ...rest,
  secretConfigured: secretCiphertext !== null,
});

const decodeWebSearchConfig = Schema.decodeUnknownEffect(WebSearchConfig);
const decodeDocumentParserConfig = Schema.decodeUnknownEffect(DocumentParserConfig);
const decodeUrlReaderConfig = Schema.decodeUnknownEffect(UrlReaderConfig);
const decodeKnowledgeSearchConfig = Schema.decodeUnknownEffect(KnowledgeSearchConfig);

export class ToolsRepo extends Context.Service<
  ToolsRepo,
  {
    getTool(name: string): Effect.Effect<PublicTool | null>;
    /**
     * Internal: decoded web_search config and the enabled providers in order,
     * with decrypted secrets, for execution.
     */
    getWebSearch(): Effect.Effect<{
      enabled: boolean;
      config: WebSearchConfig;
      providers: ReadonlyArray<SearchProviderSnapshot>;
    } | null>;
    /**
     * Internal: decoded document_parser row (no secret) for the parser service.
     */
    getDocumentParser(): Effect.Effect<{
      enabled: boolean;
      kind: string;
      config: DocumentParserConfig;
    } | null>;
    /**
     * Internal: decoded read_url row for the URL reader executor.
     */
    getUrlReader(): Effect.Effect<{ enabled: boolean; config: UrlReaderConfig } | null>;
    /**
     * Internal: decoded knowledge_search row. `enabled` turns semantic search
     * on; lexical search and document reads work regardless, so a missing or
     * disabled row is a degraded index, not an unusable collection.
     */
    getKnowledgeSearch(): Effect.Effect<{
      enabled: boolean;
      config: KnowledgeSearchConfig;
    } | null>;
    updateTool(
      name: string,
      patch: {
        enabled?: boolean;
        config?: Record<string, unknown>;
        secret?: string;
        clearSecret?: boolean;
      },
    ): Effect.Effect<PublicTool | null>;
    setToolEnabled(
      name: string,
      enabled: boolean,
    ): Effect.Effect<{ tool: PublicTool | null; changed: boolean }>;
  }
>()("chat/tools/ToolsRepo") {
  static readonly layer = Layer.effect(
    ToolsRepo,
    Effect.gen(function* () {
      const db = yield* Db;
      const cipher = yield* KeyCipher;

      const getRow = (name: string) =>
        db
          .select()
          .from(tools)
          .where(eq(tools.name, name))
          .pipe(
            Effect.map((rows) => rows[0] ?? null),
            Effect.orDie,
          );

      return ToolsRepo.of({
        getTool: Effect.fn("ToolsRepo.getTool")(function* (name) {
          const row = yield* getRow(name);
          return row ? toPublic(row) : null;
        }),

        getWebSearch: Effect.fn("ToolsRepo.getWebSearch")(function* () {
          const row = yield* getRow("web_search");
          if (!row) return null;
          const config = yield* decodeWebSearchConfig(row.config).pipe(Effect.orDie);
          const providers = yield* loadEnabledSearchProviders(db, cipher);
          return { enabled: row.enabled, config, providers };
        }),

        getDocumentParser: Effect.fn("ToolsRepo.getDocumentParser")(function* () {
          const row = yield* getRow("document_parser");
          if (!row) return null;
          const config = yield* decodeDocumentParserConfig(row.config).pipe(Effect.orDie);
          return { enabled: row.enabled, kind: row.kind, config };
        }),

        getKnowledgeSearch: Effect.fn("ToolsRepo.getKnowledgeSearch")(function* () {
          const row = yield* getRow("knowledge_search");
          if (!row) return null;
          const config = yield* decodeKnowledgeSearchConfig(row.config).pipe(Effect.orDie);
          return { enabled: row.enabled, config };
        }),

        getUrlReader: Effect.fn("ToolsRepo.getUrlReader")(function* () {
          const row = yield* getRow("read_url");
          if (!row) return null;
          const config = yield* decodeUrlReaderConfig(row.config).pipe(Effect.orDie);
          return { enabled: row.enabled, config };
        }),

        setToolEnabled: Effect.fn("ToolsRepo.setToolEnabled")(function* (name, enabled) {
          // This row can only change through the admin compatibility/CAS path.
          if (name === "knowledge_search")
            return yield* Effect.die("knowledge search configuration requires EmbeddingSpace");
          const rows = yield* db
            .update(tools)
            .set({ enabled, updatedAt: new Date() })
            .where(and(eq(tools.name, name), ne(tools.enabled, enabled)))
            .returning()
            .pipe(Effect.orDie);
          if (rows[0]) return { tool: toPublic(rows[0]), changed: true } as const;

          const current = yield* getRow(name);
          return {
            tool: current ? toPublic(current) : null,
            changed: false,
          } as const;
        }),

        updateTool: Effect.fn("ToolsRepo.updateTool")(function* (name, patch) {
          // This row can only change through the admin compatibility/CAS path.
          if (name === "knowledge_search")
            return yield* Effect.die("knowledge search configuration requires EmbeddingSpace");
          const row = yield* getRow(name);
          if (!row) return null;
          const secretCiphertext = patch.clearSecret
            ? null
            : patch.secret
              ? yield* cipher.encrypt(patch.secret)
              : row.secretCiphertext;
          const rows = yield* db
            .update(tools)
            .set({
              ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
              ...(patch.config
                ? {
                    config: {
                      ...row.config,
                      ...patch.config,
                    } as typeof row.config,
                  }
                : {}),
              secretCiphertext,
              updatedAt: new Date(),
            })
            .where(eq(tools.name, name))
            .returning()
            .pipe(Effect.orDie);
          return rows[0] ? toPublic(rows[0]) : null;
        }),
      });
    }),
  );
}
