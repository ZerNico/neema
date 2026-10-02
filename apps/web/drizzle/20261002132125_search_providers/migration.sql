CREATE TABLE "search_providers" (
	"id" text PRIMARY KEY,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"position" integer NOT NULL,
	"config" jsonb NOT NULL,
	"secret_ciphertext" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "search_providers_position_idx" ON "search_providers" ("position");