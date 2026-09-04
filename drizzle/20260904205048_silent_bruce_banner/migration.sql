ALTER TABLE "memory_settings" ALTER COLUMN "auto_save_enabled" SET DEFAULT true;--> statement-breakpoint
-- Automatic saving now ships on. Existing preferences created under the old
-- default are promoted so greenfield installs and already-migrated development
-- databases receive the same behavior.
UPDATE "memory_settings" SET "auto_save_enabled" = true WHERE "auto_save_enabled" = false;--> statement-breakpoint
-- Instance-wide memory master switch. Missing rows fail closed in application
-- code, so seed the built-in implementation enabled.
INSERT INTO "tools" ("id", "name", "kind", "enabled", "config")
VALUES (
  '01a06e30-5ae0-7299-bb4b-b9ff4a8efe1f',
  'memory',
  'memory',
  true,
  '{}'
)
ON CONFLICT ("name") DO NOTHING;