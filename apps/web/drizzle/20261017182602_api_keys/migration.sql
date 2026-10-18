CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"start" text NOT NULL,
	"hash" text NOT NULL UNIQUE,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "default_capabilities" ALTER COLUMN "capabilities" SET DEFAULT '{"agentsUse":true,"agentsCreate":true,"knowledgeUse":true,"knowledgeCreate":true,"skillsUse":true,"skillsCreate":true,"projectsUse":true,"projectsCreate":true,"schedules":true,"webSearch":true,"deepResearch":true,"memory":true,"documents":true,"customTools":true,"work":true,"attachments":true,"mcp":true,"apiKeys":true}';--> statement-breakpoint
ALTER TABLE "groups" ALTER COLUMN "capabilities" SET DEFAULT '{"agentsUse":true,"agentsCreate":true,"knowledgeUse":true,"knowledgeCreate":true,"skillsUse":true,"skillsCreate":true,"projectsUse":true,"projectsCreate":true,"schedules":true,"webSearch":true,"deepResearch":true,"memory":true,"documents":true,"customTools":true,"work":true,"attachments":true,"mcp":true,"apiKeys":true}';--> statement-breakpoint
CREATE INDEX "api_keys_user_idx" ON "api_keys" ("user_id");--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
UPDATE "groups" SET "capabilities" = "capabilities" || '{"apiKeys":true}'::jsonb WHERE NOT ("capabilities" ? 'apiKeys');--> statement-breakpoint
UPDATE "default_capabilities" SET "capabilities" = "capabilities" || '{"apiKeys":true}'::jsonb WHERE NOT ("capabilities" ? 'apiKeys');
