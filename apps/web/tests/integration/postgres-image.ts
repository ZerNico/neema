/**
 * Postgres image used by every integration container.
 *
 * Semantic knowledge search stores `vector` columns, so the migrations need
 * pgvector present; the stock `postgres:17-alpine` image cannot run them.
 * Same major version as docker-compose.yml; keep the two in step.
 */
export const POSTGRES_IMAGE =
  "pgvector/pgvector:pg17@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f";
