CREATE TABLE "integration_oauth_clients" (
	"integration_id" text,
	"issuer" text,
	"client_id" text NOT NULL,
	"client_secret_ciphertext" text,
	"method" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_oauth_clients_pkey" PRIMARY KEY("integration_id","issuer")
);
--> statement-breakpoint
CREATE TABLE "integration_tool_catalogs" (
	"integration_id" text PRIMARY KEY,
	"approved" jsonb DEFAULT '[]' NOT NULL,
	"latest" jsonb,
	"server" jsonb,
	"checked_at" timestamp with time zone,
	"check_error" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"check_lease_until" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "integration_configs" ADD COLUMN "shared_credential_ciphertext" text;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "required_scopes" jsonb;--> statement-breakpoint
CREATE INDEX "integration_tool_catalogs_due_idx" ON "integration_tool_catalogs" ("next_check_at");--> statement-breakpoint
ALTER TABLE "integration_oauth_clients" ADD CONSTRAINT "integration_oauth_clients_m5iZnrz8AXkN_fkey" FOREIGN KEY ("integration_id") REFERENCES "integration_configs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "integration_tool_catalogs" ADD CONSTRAINT "integration_tool_catalogs_IT9KGvgAqq0C_fkey" FOREIGN KEY ("integration_id") REFERENCES "integration_configs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "integration_tool_catalogs" ADD CONSTRAINT "integration_tool_catalogs_reviewed_by_user_id_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "user"("id") ON DELETE SET NULL;