CREATE TABLE "model_settings" (
	"id" text PRIMARY KEY,
	"utility_model_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_settings" ADD CONSTRAINT "model_settings_utility_model_id_models_id_fkey" FOREIGN KEY ("utility_model_id") REFERENCES "models"("id") ON DELETE SET NULL;