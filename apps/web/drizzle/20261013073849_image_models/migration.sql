ALTER TABLE "agents" ADD COLUMN "image_model_id" text;--> statement-breakpoint
ALTER TABLE "message_generation_config" ADD COLUMN "image_model_id" text;--> statement-breakpoint
ALTER TABLE "message_generation_config" ADD COLUMN "image_model_name" text;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "image_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "tool_call_id" text;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "generation_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "image_model_id" text;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "image_family" text;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "image_capabilities" jsonb;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "image_pricing" jsonb;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "image_model_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_image_model_id_models_id_fkey" FOREIGN KEY ("image_model_id") REFERENCES "models"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_image_fields" CHECK (("type" = 'image') = ("image_family" is not null and "image_capabilities" is not null));--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_image_pricing" CHECK ("type" = 'image' or "image_pricing" is null);