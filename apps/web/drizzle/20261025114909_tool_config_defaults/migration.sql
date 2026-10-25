-- Settings written before these keys existed. Every row now carries them, so
-- readers take the stored value instead of a default of their own.
UPDATE "tools"
SET "config" = "config" || '{"researchMaxSearchQueries": 80}'::jsonb
WHERE "name" = 'web_search' AND NOT "config" ? 'researchMaxSearchQueries';
--> statement-breakpoint
UPDATE "tools"
SET "config" = "config" || '{"scans": {"mode": "off"}}'::jsonb
WHERE "name" = 'document_parser' AND NOT "config" ? 'scans';
