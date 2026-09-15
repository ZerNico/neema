ALTER TABLE "message_generation_config" ADD COLUMN "research_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "research_runs" ADD COLUMN "generation_id" text;--> statement-breakpoint
ALTER TABLE "research_runs" ADD COLUMN "tool_call_id" text;--> statement-breakpoint
-- The attempt that started each run. Existing rows take it from the message
-- they used to own; one whose message never carried a generation id gets its
-- own id, which no live attempt can match, so its fence is inert by design.
UPDATE "research_runs" r SET "generation_id" = m."generation_id" FROM "messages" m WHERE m."id" = r."message_id";--> statement-breakpoint
UPDATE "research_runs" SET "generation_id" = "id" WHERE "generation_id" IS NULL;--> statement-breakpoint
ALTER TABLE "research_runs" ALTER COLUMN "generation_id" SET NOT NULL;--> statement-breakpoint
-- The old mode path synthesized the run's own `deep_research` row using the run
-- id, so the panel keeps its link wherever that row still exists.
UPDATE "research_runs" r SET "tool_call_id" = c."id" FROM "message_tool_calls" c WHERE c."id" = r."id";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "generation_mode";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "research_run_id";--> statement-breakpoint
CREATE INDEX "research_runs_tool_call_idx" ON "research_runs" ("tool_call_id");--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_tool_call_id_message_tool_calls_id_fkey" FOREIGN KEY ("tool_call_id") REFERENCES "message_tool_calls"("id") ON DELETE SET NULL;
