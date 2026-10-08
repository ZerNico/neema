CREATE TABLE "message_ui_states" (
	"message_id" text,
	"ordinal" integer,
	"source_hash" text NOT NULL,
	"state" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_ui_states_pkey" PRIMARY KEY("message_id","ordinal")
);
--> statement-breakpoint
ALTER TABLE "message_ui_states" ADD CONSTRAINT "message_ui_states_message_id_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE;