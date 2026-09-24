CREATE TABLE "signup_bootstrap" (
	"id" text PRIMARY KEY,
	"owner_id" text NOT NULL
);
--> statement-breakpoint
INSERT INTO "signup_bootstrap" ("id", "owner_id")
SELECT 'instance', COALESCE(
  (SELECT "id" FROM "user" WHERE "role" = 'admin' ORDER BY "created_at", "id" LIMIT 1),
  'legacy-no-admin'
)
WHERE EXISTS (SELECT 1 FROM "user");
--> statement-breakpoint
INSERT INTO "user_approvals" ("user_id", "status", "decided_at")
SELECT "id", 'approved', now() FROM "user"
ON CONFLICT ("user_id") DO NOTHING;
--> statement-breakpoint
CREATE INDEX "schedule_runs_pending_idx" ON "schedule_runs" ("fired_at") WHERE "status" = 'pending';