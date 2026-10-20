ALTER TABLE "oauth_providers" ADD COLUMN "signup" text DEFAULT 'approval' NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_providers" ADD COLUMN "trust_emails" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_settings" ADD COLUMN "password_signup" text;--> statement-breakpoint
ALTER TABLE "auth_settings" ADD COLUMN "password_login" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_settings" ADD COLUMN "require_email_verification" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_settings" ADD COLUMN "admit_domains" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
-- Each method inherits the one instance policy it replaces. A trusted provider
-- skipped the queue but never opened a closed instance.
UPDATE "auth_settings" SET "password_signup" = "signup_policy";--> statement-breakpoint
UPDATE "oauth_providers" p SET "signup" = CASE
  WHEN s."signup_policy" = 'closed' THEN 'closed'
  WHEN p."trusted" THEN 'open'
  ELSE s."signup_policy"
END
FROM (SELECT coalesce((SELECT "signup_policy" FROM "auth_settings" WHERE "id" = 'instance'), 'open') AS "signup_policy") s;--> statement-breakpoint
ALTER TABLE "auth_settings" ALTER COLUMN "password_signup" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_providers" DROP COLUMN "trusted";--> statement-breakpoint
ALTER TABLE "auth_settings" DROP COLUMN "signup_policy";
