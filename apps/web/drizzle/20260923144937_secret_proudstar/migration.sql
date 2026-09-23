ALTER TABLE "message_generation_config" ADD COLUMN "reasoning_effort" text;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "reasoning_effort_format" text DEFAULT 'unsupported' NOT NULL;