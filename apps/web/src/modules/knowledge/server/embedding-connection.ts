import { eq } from "drizzle-orm";
import { Effect, Option, Schema } from "effect";
import { models, providers, tools } from "~/db/schema/index.ts";
import type { Db } from "~/server/db.ts";
import type { DbTx } from "~/modules/attachments/server/repo.ts";
import { KnowledgeSearchConfig, type EmbeddingConnection } from "../schema.ts";

export const EMBEDDING_PREPROCESSING_REVISION = 1;
export interface EmbeddingTarget {
  readonly spaceId: string;
  readonly modelId: string;
  readonly dimensions: number;
  readonly connectionRevision: string;
  readonly connection: EmbeddingConnection;
}

export const sameConnection = (a: EmbeddingConnection, b: EmbeddingConnection) =>
  a.providerId === b.providerId &&
  a.baseUrl === b.baseUrl &&
  a.modelKey === b.modelKey &&
  a.modelDimensions === b.modelDimensions &&
  a.preprocessingRevision === b.preprocessingRevision;

export const decodeEmbeddingConfig = Schema.decodeUnknownOption(KnowledgeSearchConfig);

/**
 * Only public connection fields are selected. Locking callers retain the config,
 * model and provider rows through publication, never through a network request.
 */
export const readConnection = (db: Db["Service"] | DbTx, modelId: string, lock = false) =>
  Effect.gen(function* () {
    const query = db
      .select({
        providerId: providers.id,
        baseUrl: providers.baseUrl,
        modelKey: models.modelKey,
        modelDimensions: models.embeddingDimensions,
        modelEnabled: models.enabled,
        providerEnabled: providers.enabled,
        type: models.type,
        access: models.access,
      })
      .from(models)
      .innerJoin(providers, eq(providers.id, models.providerId))
      .where(eq(models.id, modelId));
    const [row] = yield* lock ? query.for("share") : query;
    if (
      !row ||
      !row.modelEnabled ||
      !row.providerEnabled ||
      row.type !== "embedding" ||
      row.access !== "public"
    )
      return null;
    return {
      providerId: row.providerId,
      baseUrl: row.baseUrl.replace(/\/$/, ""),
      modelKey: row.modelKey,
      modelDimensions: row.modelDimensions,
      preprocessingRevision: EMBEDDING_PREPROCESSING_REVISION,
    } satisfies EmbeddingConnection;
  });

export const readEmbeddingTarget = (db: Db["Service"] | DbTx, lock = false) =>
  Effect.gen(function* () {
    const query = db
      .select({ enabled: tools.enabled, config: tools.config })
      .from(tools)
      .where(eq(tools.name, "knowledge_search"));
    const [row] = yield* lock ? query.for("share") : query;
    if (!row?.enabled) return null;
    const decoded = decodeEmbeddingConfig(row.config);
    if (Option.isNone(decoded)) return null;
    const config = decoded.value;
    if (
      !config.spaceId ||
      !config.embeddingModelId ||
      !config.dimensions ||
      !config.connectionRevision ||
      !config.approvedConnection
    )
      return null;
    const connection = yield* readConnection(db, config.embeddingModelId, lock);
    if (!connection || !sameConnection(config.approvedConnection, connection)) return null;
    return {
      spaceId: config.spaceId,
      modelId: config.embeddingModelId,
      dimensions: config.dimensions,
      connectionRevision: config.connectionRevision,
      connection,
    } satisfies EmbeddingTarget;
  });
