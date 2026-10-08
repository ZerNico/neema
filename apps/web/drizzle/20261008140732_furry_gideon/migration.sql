-- A subscription without its sign-in cannot be stopped by signing out; the
-- browser subscribes again on its next visit.
DELETE FROM "push_subscriptions";--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD COLUMN "session_id" text NOT NULL;--> statement-breakpoint
CREATE INDEX "push_subscriptions_session_idx" ON "push_subscriptions" ("session_id");--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE;