ALTER TABLE "documents" ADD COLUMN "text_length" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "tasks_done" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "tasks_total" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Existing documents: what their Markdown says, until their next write derives it from the tree.
UPDATE "documents" SET
  "text_length" = length("content"),
  "tasks_total" = regexp_count("content", '^\s*- \[[ x]\] ', 1, 'n'),
  "tasks_done" = regexp_count("content", '^\s*- \[x\] ', 1, 'n');--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "content";