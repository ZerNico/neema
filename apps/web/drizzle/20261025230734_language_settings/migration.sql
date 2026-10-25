CREATE TABLE "language_settings" (
	"user_id" text PRIMARY KEY,
	"chosen" text,
	"browser" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "language_settings" ADD CONSTRAINT "language_settings_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;