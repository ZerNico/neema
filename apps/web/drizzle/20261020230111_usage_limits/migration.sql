CREATE TABLE "limit_settings" (
	"id" integer PRIMARY KEY,
	"time_zone" text DEFAULT 'UTC' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_limit_models" (
	"limit_id" text,
	"model_id" text,
	CONSTRAINT "usage_limit_models_pkey" PRIMARY KEY("limit_id","model_id")
);
--> statement-breakpoint
CREATE TABLE "usage_limits" (
	"id" text PRIMARY KEY,
	"group_id" text,
	"metric" text NOT NULL,
	"period" text NOT NULL,
	"amount" double precision,
	"all_models" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "usage_limits_group_idx" ON "usage_limits" ("group_id");--> statement-breakpoint
ALTER TABLE "usage_limit_models" ADD CONSTRAINT "usage_limit_models_limit_id_usage_limits_id_fkey" FOREIGN KEY ("limit_id") REFERENCES "usage_limits"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "usage_limit_models" ADD CONSTRAINT "usage_limit_models_model_id_models_id_fkey" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "usage_limits" ADD CONSTRAINT "usage_limits_group_id_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE;--> statement-breakpoint
INSERT INTO "limit_settings" ("id") VALUES (1);
