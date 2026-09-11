CREATE TABLE "auth_settings" (
	"id" text PRIMARY KEY,
	"signup_policy" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_approvals" (
	"user_id" text PRIMARY KEY,
	"status" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text
);
--> statement-breakpoint
ALTER TABLE "oauth_providers" ADD COLUMN "trusted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_approvals" ADD CONSTRAINT "user_approvals_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_approvals" ADD CONSTRAINT "user_approvals_decided_by_user_id_fkey" FOREIGN KEY ("decided_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
INSERT INTO "auth_settings" ("id", "signup_policy") VALUES ('instance', 'approval');--> statement-breakpoint
INSERT INTO "user_approvals" ("user_id", "status", "decided_at") SELECT "id", 'approved', now() FROM "user";
