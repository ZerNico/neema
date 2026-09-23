CREATE TABLE "default_capabilities" (
	"id" integer PRIMARY KEY,
	"capabilities" jsonb DEFAULT '{"agentsUse":true,"agentsCreate":true,"knowledgeUse":true,"knowledgeCreate":true,"skillsUse":true,"skillsCreate":true,"schedules":true,"webSearch":true,"deepResearch":true,"memory":true,"documents":true,"customTools":true,"work":true,"attachments":true}' NOT NULL
);
--> statement-breakpoint
INSERT INTO "default_capabilities" ("id") VALUES (1);
--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "capabilities" jsonb DEFAULT '{"agentsUse":true,"agentsCreate":true,"knowledgeUse":true,"knowledgeCreate":true,"skillsUse":true,"skillsCreate":true,"schedules":true,"webSearch":true,"deepResearch":true,"memory":true,"documents":true,"customTools":true,"work":true,"attachments":true}' NOT NULL;