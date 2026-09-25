CREATE TABLE "project_file_settings" (
	"id" integer PRIMARY KEY,
	"max_project_bytes" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_file_versions" (
	"id" text PRIMARY KEY,
	"file_id" text NOT NULL,
	"number" integer NOT NULL,
	"blob_id" text NOT NULL,
	"size" integer NOT NULL,
	"media_type" text NOT NULL,
	"origin" text NOT NULL,
	"created_by_user_id" text,
	"generation_id" text,
	"pinned" boolean DEFAULT false NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_files" (
	"id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "project_file_versions_file_number_idx" ON "project_file_versions" ("file_id","number");--> statement-breakpoint
CREATE INDEX "project_file_versions_blob_id_idx" ON "project_file_versions" ("blob_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_files_project_name_idx" ON "project_files" ("project_id","name");--> statement-breakpoint
ALTER TABLE "project_file_versions" ADD CONSTRAINT "project_file_versions_file_id_project_files_id_fkey" FOREIGN KEY ("file_id") REFERENCES "project_files"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project_file_versions" ADD CONSTRAINT "project_file_versions_blob_id_attachment_blobs_id_fkey" FOREIGN KEY ("blob_id") REFERENCES "attachment_blobs"("id");--> statement-breakpoint
ALTER TABLE "project_file_versions" ADD CONSTRAINT "project_file_versions_created_by_user_id_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;