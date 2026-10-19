ALTER TABLE "integration_configs" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "default_capabilities" ALTER COLUMN "capabilities" SET DEFAULT '{"agentsUse":true,"agentsCreate":true,"knowledgeUse":true,"knowledgeCreate":true,"skillsUse":true,"skillsCreate":true,"projectsUse":true,"projectsCreate":true,"schedules":true,"webSearch":true,"deepResearch":true,"memory":true,"documents":true,"customTools":true,"work":true,"attachments":true,"mcp":true,"apiKeys":true,"mcpServers":true}';--> statement-breakpoint
ALTER TABLE "groups" ALTER COLUMN "capabilities" SET DEFAULT '{"agentsUse":true,"agentsCreate":true,"knowledgeUse":true,"knowledgeCreate":true,"skillsUse":true,"skillsCreate":true,"projectsUse":true,"projectsCreate":true,"schedules":true,"webSearch":true,"deepResearch":true,"memory":true,"documents":true,"customTools":true,"work":true,"attachments":true,"mcp":true,"apiKeys":true,"mcpServers":true}';--> statement-breakpoint
DROP INDEX "integration_configs_name_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "integration_configs_name_idx" ON "integration_configs" (coalesce("owner_user_id", ''),lower("name"));--> statement-breakpoint
CREATE INDEX "integration_configs_owner_idx" ON "integration_configs" ("owner_user_id");--> statement-breakpoint
ALTER TABLE "integration_configs" ADD CONSTRAINT "integration_configs_owner_user_id_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
UPDATE "groups" SET "capabilities" = "capabilities" || '{"mcpServers":false}'::jsonb WHERE NOT ("capabilities" ? 'mcpServers');--> statement-breakpoint
UPDATE "default_capabilities" SET "capabilities" = "capabilities" || '{"mcpServers":false}'::jsonb WHERE NOT ("capabilities" ? 'mcpServers');
