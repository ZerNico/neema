ALTER TABLE "notification_settings" ADD COLUMN "push" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "push_subscriptions" DROP COLUMN "label";--> statement-breakpoint
ALTER TABLE "push_subscriptions" DROP COLUMN "last_delivered_at";