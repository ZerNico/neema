-- Integrations become instances of a type. Existing rows keep their id, which was the type.
ALTER TABLE "integration_configs" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "integration_configs" ADD COLUMN "name" text;--> statement-breakpoint
-- Ids referenced before an admin ever saved setup get a row, turned off, so the new foreign keys keep them.
INSERT INTO "integration_configs" ("id")
SELECT DISTINCT "integration_id" FROM (
  SELECT "integration_id" FROM "agent_integrations"
  UNION SELECT "integration_id" FROM "conversation_integrations"
  UNION SELECT "integration_id" FROM "integration_allowance_uses"
  UNION SELECT "integration_id" FROM "knowledge_sources"
) AS "referenced"
WHERE "integration_id" NOT IN (SELECT "id" FROM "integration_configs");--> statement-breakpoint
UPDATE "integration_configs" SET
  "kind" = "id",
  "name" = CASE "id"
    WHEN 'outline' THEN 'Outline'
    WHEN 'outlook' THEN 'Outlook'
    WHEN 'jira' THEN 'Jira'
    ELSE initcap("id")
  END;--> statement-breakpoint
ALTER TABLE "integration_configs" ALTER COLUMN "kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_configs" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_configs_name_idx" ON "integration_configs" (lower("name"));--> statement-breakpoint
ALTER TABLE "agent_integrations" ADD CONSTRAINT "agent_integrations_integration_id_integration_configs_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integration_configs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "conversation_integrations" ADD CONSTRAINT "conversation_integrations_k1M6VEBZGC7j_fkey" FOREIGN KEY ("integration_id") REFERENCES "integration_configs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "integration_allowance_uses" ADD CONSTRAINT "integration_allowance_uses_M8ZDLn5yDX0w_fkey" FOREIGN KEY ("integration_id") REFERENCES "integration_configs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_integration_id_integration_configs_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integration_configs"("id") ON DELETE RESTRICT;
