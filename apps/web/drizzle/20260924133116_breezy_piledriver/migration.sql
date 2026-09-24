ALTER TABLE "schedule_runs" ADD COLUMN "lease_until" timestamp with time zone DEFAULT clock_timestamp() + interval '60 seconds' NOT NULL;--> statement-breakpoint
DROP INDEX "schedule_runs_pending_idx";--> statement-breakpoint
CREATE INDEX "schedule_runs_pending_idx" ON "schedule_runs" ("lease_until") WHERE "status" = 'pending';