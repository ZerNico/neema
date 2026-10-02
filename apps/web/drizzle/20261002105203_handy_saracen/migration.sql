ALTER TABLE "presentation_fonts" ADD COLUMN "source" text DEFAULT 'upload' NOT NULL;--> statement-breakpoint
ALTER TABLE "presentation_fonts" ADD COLUMN "last_used_at" timestamp with time zone;