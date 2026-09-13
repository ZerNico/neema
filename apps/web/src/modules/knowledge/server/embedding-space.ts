import { notifyOnCommit } from "~/modules/sync/server/signals.ts";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { uuidv7 } from "uuidv7";
import { tools, user } from "~/db/schema/index.ts";
import type { DbTx } from "~/modules/attachments/server/repo.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { KnowledgeRejected } from "../errors.ts";
import {
  DisableEmbeddingInput,
  EmbeddingConfigurationChange,
  type EmbeddingConfigurationStatus,
  type KnowledgeSearchConfig,
} from "../schema.ts";
import {
  decodeEmbeddingConfig,
  readConnection,
  readEmbeddingTarget,
  sameConnection,
  type EmbeddingTarget,
} from "./embedding-connection.ts";

export type { EmbeddingTarget } from "./embedding-connection.ts";
export type { EmbeddingConfigurationChange } from "../schema.ts";

export class EmbeddingSpace extends Context.Service<
  EmbeddingSpace,
  {
    /** Null also means a connection edit needs an explicit compatibility decision. */
    current(): Effect.Effect<EmbeddingTarget | null>;
    detail(userId: string): Effect.Effect<EmbeddingConfigurationStatus, KnowledgeRejected>;
    /** Admin-only, compare-and-set approval. Does not submit existing corpora. */
    configure(
      userId: string,
      input: EmbeddingConfigurationChange,
    ): Effect.Effect<KnowledgeSearchConfig, KnowledgeRejected>;
    disable(
      userId: string,
      input: DisableEmbeddingInput,
    ): Effect.Effect<KnowledgeSearchConfig, KnowledgeRejected>;
  }
>()("chat/knowledge/EmbeddingSpace") {
  static readonly layer = Layer.effect(
    EmbeddingSpace,
    Effect.gen(function* () {
      const db = yield* Db;
      const sync = yield* SyncBus;
      const withConfiguration = <A>(
        userId: string,
        lock: "share" | "update",
        use: (
          tx: DbTx,
          row: { enabled: boolean; config: KnowledgeSearchConfig },
        ) => Effect.Effect<A, KnowledgeRejected>,
      ) =>
        db
          .transaction((tx) =>
            Effect.gen(function* () {
              const [actor] = yield* tx
                .select({ role: user.role })
                .from(user)
                .where(eq(user.id, userId))
                .for("share");
              if (actor?.role !== "admin")
                return yield* new KnowledgeRejected({
                  reason: "only admins can configure semantic search",
                });
              const [row] = yield* tx
                .select({ enabled: tools.enabled, config: tools.config })
                .from(tools)
                .where(eq(tools.name, "knowledge_search"))
                .for(lock);
              if (!row)
                return yield* new KnowledgeRejected({
                  reason: "knowledge search is not installed",
                });
              const decoded = decodeEmbeddingConfig(row.config);
              if (Option.isNone(decoded))
                return yield* new KnowledgeRejected({
                  reason: "knowledge search configuration is invalid",
                });
              return yield* use(tx, { enabled: row.enabled, config: decoded.value });
            }),
          )
          .pipe(
            Effect.catchTag("EffectDrizzleQueryError", Effect.die),
            Effect.catchTag("SqlError", Effect.die),
          );
      const changed = () =>
        sync
          .publishGlobal({ type: "resources.changed" })
          .pipe(
            Effect.catchCause(() =>
              Effect.logWarning("embedding configuration changed but resource invalidation failed"),
            ),
          );
      const checkRevision = (config: KnowledgeSearchConfig, expectedRevision: string | null) =>
        config.connectionRevision === expectedRevision
          ? Effect.void
          : Effect.fail(
              new KnowledgeRejected({ reason: "configuration changed; reload before confirming" }),
            );

      return EmbeddingSpace.of({
        current: () => readEmbeddingTarget(db).pipe(Effect.orDie),
        detail: (userId) =>
          withConfiguration(userId, "share", (tx, row) =>
            Effect.gen(function* () {
              const target = yield* readEmbeddingTarget(tx, true).pipe(Effect.orDie);
              return {
                ...row,
                status: !row.enabled ? "disabled" : target ? "ready" : "needs_approval",
              } satisfies EmbeddingConfigurationStatus;
            }),
          ),
        configure: Effect.fn("EmbeddingSpace.configure")(function* (userId, input) {
          const valid = yield* Schema.decodeUnknownEffect(EmbeddingConfigurationChange)(input).pipe(
            Effect.mapError(
              () => new KnowledgeRejected({ reason: "invalid embedding configuration" }),
            ),
          );
          const result = yield* withConfiguration(userId, "update", (tx, { config: previous }) =>
            Effect.gen(function* () {
              yield* checkRevision(previous, valid.expectedRevision);
              const connection = yield* readConnection(tx, valid.modelId, true).pipe(Effect.orDie);
              if (!connection)
                return yield* new KnowledgeRejected({
                  reason: "select an enabled, instance-usable embedding model",
                });
              if (
                valid.decision === "keep" &&
                (!previous.spaceId ||
                  !previous.approvedConnection ||
                  previous.dimensions !== valid.dimensions ||
                  previous.approvedConnection.preprocessingRevision !==
                    connection.preprocessingRevision ||
                  previous.approvedConnection.modelDimensions !== connection.modelDimensions)
              )
                return yield* new KnowledgeRejected({
                  reason: "changed dimensions or preprocessing require a rebuild",
                });
              const unchanged =
                valid.decision === "keep" &&
                previous.embeddingModelId === valid.modelId &&
                previous.approvedConnection &&
                sameConnection(previous.approvedConnection, connection);
              const config: KnowledgeSearchConfig = {
                spaceId: valid.decision === "keep" ? previous.spaceId! : uuidv7(),
                embeddingModelId: valid.modelId,
                dimensions: valid.dimensions,
                approvedConnection: connection,
                connectionRevision: unchanged ? previous.connectionRevision! : uuidv7(),
              };
              yield* tx
                .update(tools)
                .set({ enabled: true, config, updatedAt: new Date() })
                .where(eq(tools.name, "knowledge_search"))
                .pipe(Effect.orDie);
              // Approval never bulk-submits old corpora. Owners explicitly reindex
              // unfinished work; compatible ready vectors remain usable.
              yield* notifyOnCommit(tx, {
                scope: "internal",
                event: { type: "knowledge.work", stage: "embedding" },
              });
              return config;
            }),
          );
          yield* changed();
          return result;
        }),
        disable: Effect.fn("EmbeddingSpace.disable")(function* (userId, input) {
          const valid = yield* Schema.decodeUnknownEffect(DisableEmbeddingInput)(input).pipe(
            Effect.mapError(
              () => new KnowledgeRejected({ reason: "invalid embedding configuration" }),
            ),
          );
          const result = yield* withConfiguration(userId, "update", (tx, row) =>
            Effect.gen(function* () {
              yield* checkRevision(row.config, valid.expectedRevision);
              if (!row.enabled) return row.config;
              // Rotate the revision to fence dispatched work and stale enable
              // drafts, even if a later approval restores the same vector space.
              const config = { ...row.config, connectionRevision: uuidv7() };
              yield* tx
                .update(tools)
                .set({ enabled: false, config, updatedAt: new Date() })
                .where(eq(tools.name, "knowledge_search"))
                .pipe(Effect.orDie);
              yield* notifyOnCommit(tx, {
                scope: "internal",
                event: { type: "knowledge.work", stage: "embedding" },
              });
              return config;
            }),
          );
          yield* changed();
          return result;
        }),
      });
    }),
  );
}
