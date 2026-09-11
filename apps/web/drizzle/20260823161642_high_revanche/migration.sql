CREATE TABLE "usage_events" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"model_id" text,
	"model_name" text NOT NULL,
	"conversation_id" text,
	"message_id" text,
	"status" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"reasoning_tokens" integer DEFAULT 0 NOT NULL,
	"cost" double precision,
	"cost_source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "pricing" jsonb;--> statement-breakpoint
CREATE INDEX "usage_events_user_created_idx" ON "usage_events" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_events_created_idx" ON "usage_events" ("created_at");--> statement-breakpoint
CREATE INDEX "usage_events_model_idx" ON "usage_events" ("model_id");--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_model_id_models_id_fkey" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE SET NULL;