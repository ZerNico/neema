import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Schema, type Redacted } from "effect";
import { Db } from "~/server/db.ts";
import { tools } from "~/db/schema/index.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { WebSearchConfig } from "../schema.ts";

type ToolRow = typeof tools.$inferSelect;
// Tool rows safe for admin clients: ciphertext replaced by a boolean.
export type PublicTool = Omit<ToolRow, "secretCiphertext"> & { secretConfigured: boolean };

const toPublic = ({ secretCiphertext, ...rest }: ToolRow): PublicTool => ({
  ...rest,
  secretConfigured: secretCiphertext !== null,
});

const decodeWebSearchConfig = Schema.decodeUnknownEffect(WebSearchConfig);

export class ToolsRepo extends Context.Service<
  ToolsRepo,
  {
    getTool(name: string): Effect.Effect<PublicTool | null>;
    // Internal: decoded web_search config + decrypted secret, for execution.
    getWebSearch(): Effect.Effect<{
      enabled: boolean;
      config: WebSearchConfig;
      secret: Redacted.Redacted<string> | null;
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
          const secret = row.secretCiphertext ? yield* cipher.decrypt(row.secretCiphertext) : null;
          return { enabled: row.enabled, config, secret };
        }),

        updateTool: Effect.fn("ToolsRepo.updateTool")(function* (name, patch) {
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
