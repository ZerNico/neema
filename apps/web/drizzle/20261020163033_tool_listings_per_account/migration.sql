CREATE TABLE "integration_tool_listings" (
	"id" text PRIMARY KEY,
	"integration_id" text NOT NULL,
	"connection_id" text,
	"tools" jsonb,
	"server" jsonb,
	"checked_at" timestamp with time zone,
	"check_error" text,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"check_lease_until" timestamp with time zone,
	"check_token" text
);
--> statement-breakpoint
ALTER TABLE "integration_configs" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "integration_configs" ADD COLUMN "tool_settings" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
-- What an admin chose in a review stays theirs: a tool left off stays off, a corrected access stays.
UPDATE "integration_configs" i SET "tool_settings" = coalesce((
  SELECT jsonb_object_agg(e->>'mcpName', jsonb_strip_nulls(jsonb_build_object(
    'off', CASE WHEN coalesce((e->>'enabled')::boolean, false) THEN NULL ELSE true END,
    'access', CASE WHEN coalesce((e->>'accessChosen')::boolean, false) THEN e->>'access' END)))
  FROM jsonb_array_elements(c."approved") e
  WHERE NOT (coalesce((e->>'enabled')::boolean, false) AND NOT coalesce((e->>'accessChosen')::boolean, false))
), '{}'::jsonb)
FROM "integration_tool_catalogs" c
WHERE c."integration_id" = i."id";--> statement-breakpoint
-- Every MCP account lists its own tools from now on. Each starts from what the server last
-- listed, so chats keep their tools, and is due at once, so the sweep refreshes it.
INSERT INTO "integration_tool_listings" ("id", "integration_id", "connection_id", "tools", "server", "checked_at")
SELECT c."id", c."integration_id", c."id", (SELECT jsonb_agg(e - 'enabled' - 'accessChosen') FROM jsonb_array_elements(t."latest") e), t."server", t."checked_at"
FROM "integration_connections" c
JOIN "integration_configs" i ON i."id" = c."integration_id"
LEFT JOIN "integration_tool_catalogs" t ON t."integration_id" = i."id"
WHERE i."kind" = 'mcp' AND c."auth_kind" IN ('oauth', 'api_key');--> statement-breakpoint
-- A way in without an account (open, or the admin's key) lists once for everyone.
INSERT INTO "integration_tool_listings" ("id", "integration_id", "tools", "server", "checked_at")
SELECT i."id", i."id", (SELECT jsonb_agg(e - 'enabled' - 'accessChosen') FROM jsonb_array_elements(t."latest") e), t."server", t."checked_at"
FROM "integration_configs" i
LEFT JOIN "integration_tool_catalogs" t ON t."integration_id" = i."id"
WHERE i."kind" = 'mcp' AND i."config"->>'ways' LIKE '%anonymous%';--> statement-breakpoint
DROP TABLE "integration_tool_catalogs";--> statement-breakpoint
CREATE INDEX "integration_tool_listings_due_idx" ON "integration_tool_listings" ("next_check_at");--> statement-breakpoint
CREATE INDEX "integration_tool_listings_integration_idx" ON "integration_tool_listings" ("integration_id");--> statement-breakpoint
ALTER TABLE "integration_tool_listings" ADD CONSTRAINT "integration_tool_listings_Wz83IWOHoIjD_fkey" FOREIGN KEY ("integration_id") REFERENCES "integration_configs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "integration_tool_listings" ADD CONSTRAINT "integration_tool_listings_vROyRz303ZKH_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connections"("id") ON DELETE CASCADE;