ALTER TABLE "messages" ADD COLUMN "generation_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "assistant_output" jsonb;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "provider_replay" jsonb;