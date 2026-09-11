ALTER TABLE "message_generation_config" RENAME COLUMN "snapshot" TO "resolved_agent";--> statement-breakpoint
ALTER TABLE "message_generation_config" ADD COLUMN "standalone_collection_ids" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_agents" DROP COLUMN "snapshot";