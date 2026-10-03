ALTER TABLE "usage_events" ADD COLUMN "cache_write_tokens" integer;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "preset" text NOT NULL;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "settings" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "providers" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "providers" DROP COLUMN "reasoning_effort_format";--> statement-breakpoint
ALTER TABLE "models" ALTER COLUMN "capabilities" SET DEFAULT '{"imageOutput":false,"reasoning":false,"tools":false,"vision":false,"files":false}';--> statement-breakpoint
ALTER TABLE "providers" ALTER COLUMN "api_key_ciphertext" DROP NOT NULL;