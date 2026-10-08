CREATE TABLE "sidebar_pins" (
	"user_id" text PRIMARY KEY,
	"pinned" text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sidebar_pins" ADD CONSTRAINT "sidebar_pins_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;