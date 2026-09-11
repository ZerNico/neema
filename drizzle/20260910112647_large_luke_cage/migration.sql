CREATE TABLE "conversation_agent_drafts" (
	"conversation_id" text PRIMARY KEY,
	"settings" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"target_agent_id" text,
	"target_revision" integer,
	"saved_draft_revision" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_agent_drafts" ADD CONSTRAINT "conversation_agent_drafts_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE;