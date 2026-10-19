ALTER TABLE "conversation_integrations" DROP CONSTRAINT "conversation_integrations_k1M6VEBZGC7j_fkey";--> statement-breakpoint
ALTER TABLE "integration_allowance_uses" DROP CONSTRAINT "integration_allowance_uses_M8ZDLn5yDX0w_fkey";--> statement-breakpoint
ALTER TABLE "conversation_integrations" ADD COLUMN "connection_id" text;--> statement-breakpoint
ALTER TABLE "integration_allowance_uses" ADD COLUMN "connection_id" text;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "account_key" text;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN "connection_id" text;--> statement-breakpoint
-- Every row so far meant the owner's only connection of that integration.
UPDATE "conversation_integrations" AS ci SET "connection_id" = c."id"
  FROM "conversations" AS cv, "integration_connections" AS c
  WHERE cv."id" = ci."conversation_id" AND c."user_id" = cv."user_id" AND c."integration_id" = ci."integration_id";--> statement-breakpoint
DELETE FROM "conversation_integrations" WHERE "connection_id" IS NULL;--> statement-breakpoint
UPDATE "integration_allowance_uses" AS u SET "connection_id" = c."id"
  FROM "messages" AS m, "conversations" AS cv, "integration_connections" AS c
  WHERE m."id" = u."message_id" AND cv."id" = m."conversation_id" AND c."user_id" = cv."user_id" AND c."integration_id" = u."integration_id";--> statement-breakpoint
DELETE FROM "integration_allowance_uses" WHERE "connection_id" IS NULL;--> statement-breakpoint
UPDATE "knowledge_sources" AS ks SET "connection_id" = c."id"
  FROM "knowledge_collections" AS kc, "integration_connections" AS c
  WHERE kc."id" = ks."collection_id" AND c."user_id" = kc."user_id" AND c."integration_id" = ks."integration_id";--> statement-breakpoint
ALTER TABLE "conversation_integrations" DROP COLUMN "integration_id";--> statement-breakpoint
ALTER TABLE "integration_allowance_uses" DROP COLUMN "integration_id";--> statement-breakpoint
ALTER TABLE "conversation_integrations" ADD PRIMARY KEY ("conversation_id","connection_id");--> statement-breakpoint
ALTER TABLE "integration_allowance_uses" ADD PRIMARY KEY ("message_id","connection_id","allowance_id");--> statement-breakpoint
DROP INDEX "integration_connections_user_idx";--> statement-breakpoint
CREATE INDEX "integration_connections_user_idx" ON "integration_connections" ("user_id","integration_id");--> statement-breakpoint
CREATE INDEX "conversation_integrations_connection_idx" ON "conversation_integrations" ("connection_id");--> statement-breakpoint
CREATE INDEX "integration_allowance_uses_connection_idx" ON "integration_allowance_uses" ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_connections_account_idx" ON "integration_connections" ("user_id","integration_id","account_key") WHERE "account_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_connections_open_idx" ON "integration_connections" ("user_id","integration_id") WHERE "auth_kind" in ('none', 'shared');--> statement-breakpoint
CREATE INDEX "knowledge_sources_connection_idx" ON "knowledge_sources" ("connection_id");--> statement-breakpoint
ALTER TABLE "conversation_integrations" ADD CONSTRAINT "conversation_integrations_TksC4gQilTyn_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "integration_allowance_uses" ADD CONSTRAINT "integration_allowance_uses_X7kg83jvVR8W_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_connection_id_integration_connections_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connections"("id") ON DELETE SET NULL;