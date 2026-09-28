CREATE TABLE "presentation_fonts" (
	"id" text PRIMARY KEY,
	"family" text NOT NULL,
	"render_family" text NOT NULL,
	"style" text NOT NULL,
	"bold" boolean NOT NULL,
	"italic" boolean NOT NULL,
	"embeddable" boolean NOT NULL,
	"format" text NOT NULL,
	"file_name" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"bytes" bytea NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_working_files" (
	"working_file_id" text,
	"message_id" text,
	"conversation_id" text NOT NULL,
	"attachment_id" text,
	"name" text NOT NULL,
	"media_type" text NOT NULL,
	"owner" text NOT NULL,
	"custom_tool_id" text,
	"revision" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"source" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_working_files_pkey" PRIMARY KEY("working_file_id","message_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "presentation_fonts_face_idx" ON "presentation_fonts" ("family","bold","italic");--> statement-breakpoint
CREATE INDEX "conversation_working_files_conversation_idx" ON "conversation_working_files" ("conversation_id");--> statement-breakpoint
CREATE INDEX "conversation_working_files_message_idx" ON "conversation_working_files" ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_working_files_attachment_idx" ON "conversation_working_files" ("attachment_id");--> statement-breakpoint
CREATE INDEX "conversation_working_files_updated_idx" ON "conversation_working_files" ("updated_at");--> statement-breakpoint
ALTER TABLE "presentation_fonts" ADD CONSTRAINT "presentation_fonts_created_by_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "conversation_working_files" ADD CONSTRAINT "conversation_working_files_message_id_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "conversation_working_files" ADD CONSTRAINT "conversation_working_files_4JhPxnPCa3nM_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "conversation_working_files" ADD CONSTRAINT "conversation_working_files_attachment_id_attachments_id_fkey" FOREIGN KEY ("attachment_id") REFERENCES "attachments"("id") ON DELETE CASCADE;