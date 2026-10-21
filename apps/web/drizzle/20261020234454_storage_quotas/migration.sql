CREATE TABLE "group_storage_quotas" (
	"group_id" text PRIMARY KEY,
	"bytes" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "limit_settings" ADD COLUMN "storage_bytes" bigint;--> statement-breakpoint
ALTER TABLE "group_storage_quotas" ADD CONSTRAINT "group_storage_quotas_group_id_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE;