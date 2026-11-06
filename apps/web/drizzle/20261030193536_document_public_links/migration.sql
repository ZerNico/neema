CREATE TABLE "document_public_links" (
	"document_id" text PRIMARY KEY,
	"token" text NOT NULL UNIQUE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "default_capabilities" ALTER COLUMN "capabilities" SET DEFAULT '{"agentsUse":true,"agentsCreate":true,"knowledgeUse":true,"knowledgeCreate":true,"skillsUse":true,"skillsCreate":true,"projectsUse":true,"projectsCreate":true,"schedules":true,"webSearch":true,"deepResearch":true,"memory":true,"documents":true,"customTools":true,"work":true,"attachments":true,"mcp":true,"apiKeys":true,"mcpServers":true,"publicLinks":true}';--> statement-breakpoint
ALTER TABLE "groups" ALTER COLUMN "capabilities" SET DEFAULT '{"agentsUse":true,"agentsCreate":true,"knowledgeUse":true,"knowledgeCreate":true,"skillsUse":true,"skillsCreate":true,"projectsUse":true,"projectsCreate":true,"schedules":true,"webSearch":true,"deepResearch":true,"memory":true,"documents":true,"customTools":true,"work":true,"attachments":true,"mcp":true,"apiKeys":true,"mcpServers":true,"publicLinks":true}';--> statement-breakpoint
ALTER TABLE "document_public_links" ADD CONSTRAINT "document_public_links_document_id_documents_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE;--> statement-breakpoint
UPDATE "groups" SET "capabilities" = "capabilities" || '{"publicLinks":false}'::jsonb WHERE NOT ("capabilities" ? 'publicLinks');--> statement-breakpoint
UPDATE "default_capabilities" SET "capabilities" = "capabilities" || '{"publicLinks":false}'::jsonb WHERE NOT ("capabilities" ? 'publicLinks');
