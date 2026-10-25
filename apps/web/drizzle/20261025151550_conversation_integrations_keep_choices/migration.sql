ALTER TABLE "conversation_integrations" DROP CONSTRAINT "conversation_integrations_pkey";--> statement-breakpoint
ALTER TABLE "conversation_integrations" ADD COLUMN "integration_id" text;--> statement-breakpoint
-- Every row still names its account, which names the integration.
UPDATE "conversation_integrations" ci SET "integration_id" = c."integration_id"
FROM "integration_connections" c WHERE c."id" = ci."connection_id";--> statement-breakpoint
ALTER TABLE "conversation_integrations" ALTER COLUMN "integration_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_integrations" ALTER COLUMN "connection_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_integrations_account_idx" ON "conversation_integrations" ("conversation_id","connection_id");--> statement-breakpoint
CREATE INDEX "conversation_integrations_integration_idx" ON "conversation_integrations" ("integration_id");--> statement-breakpoint
ALTER TABLE "conversation_integrations" ADD CONSTRAINT "conversation_integrations_k1M6VEBZGC7j_fkey" FOREIGN KEY ("integration_id") REFERENCES "integration_configs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "conversation_integrations" DROP CONSTRAINT "conversation_integrations_TksC4gQilTyn_fkey", ADD CONSTRAINT "conversation_integrations_TksC4gQilTyn_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connections"("id") ON DELETE SET NULL;