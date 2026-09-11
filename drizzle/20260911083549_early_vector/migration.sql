-- Drafts were keyed by conversation_id, which allowed exactly one per chat.
-- Rekeyed on their own id so a chat can prepare several agents at once.
-- Recreated rather than migrated in place: the feature is unreleased and the
-- only rows are throwaway drafts from local testing.
DROP TABLE IF EXISTS "conversation_agent_drafts";--> statement-breakpoint
CREATE TABLE "conversation_agent_drafts" (
	"id" text PRIMARY KEY,
	"conversation_id" text NOT NULL,
	"settings" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"target_agent_id" text,
	"target_revision" integer,
	"saved_draft_revision" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_agent_drafts" ADD CONSTRAINT "conversation_agent_drafts_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE INDEX "conversation_agent_drafts_conversation_idx" ON "conversation_agent_drafts" ("conversation_id");
