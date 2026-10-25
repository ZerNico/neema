CREATE TABLE "schedule_integration_grants" (
	"schedule_id" text NOT NULL,
	"connection_id" text,
	"integration_id" text NOT NULL,
	"access" text NOT NULL,
	"allowances" jsonb
);
--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_integration_grants_account_idx" ON "schedule_integration_grants" ("schedule_id","connection_id");--> statement-breakpoint
CREATE INDEX "schedule_integration_grants_connection_idx" ON "schedule_integration_grants" ("connection_id");--> statement-breakpoint
CREATE INDEX "schedule_integration_grants_integration_idx" ON "schedule_integration_grants" ("integration_id");--> statement-breakpoint
ALTER TABLE "schedule_integration_grants" ADD CONSTRAINT "schedule_integration_grants_schedule_id_schedules_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "schedules"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "schedule_integration_grants" ADD CONSTRAINT "schedule_integration_grants_7VUiEXTbTMJa_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connections"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "schedule_integration_grants" ADD CONSTRAINT "schedule_integration_grants_KmhvgRXvANwW_fkey" FOREIGN KEY ("integration_id") REFERENCES "integration_configs"("id") ON DELETE CASCADE;--> statement-breakpoint
-- Each JSON grant becomes a row. One whose account is gone, or is not the owner's
-- on that integration, keeps its place with no account, as the editor showed it.
-- Two grants for one account (the rebind bug) keep the narrower, read.
INSERT INTO "schedule_integration_grants" ("schedule_id", "connection_id", "integration_id", "access", "allowances")
SELECT DISTINCT ON (s."id", g.entry ->> 'connectionId')
  s."id",
  c."id",
  g.entry ->> 'integrationId',
  g.entry ->> 'access',
  g.entry -> 'allowances'
FROM "schedules" s
CROSS JOIN LATERAL jsonb_array_elements(s."integration_grants") AS g(entry)
JOIN "integration_configs" i ON i."id" = g.entry ->> 'integrationId'
LEFT JOIN "integration_connections" c
  ON c."id" = g.entry ->> 'connectionId'
  AND c."user_id" = s."user_id"
  AND c."integration_id" = i."id"
WHERE g.entry ->> 'access' IN ('read', 'write')
ORDER BY s."id", g.entry ->> 'connectionId', (g.entry ->> 'access') = 'write';--> statement-breakpoint
ALTER TABLE "schedules" DROP COLUMN "integration_grants";
