CREATE TABLE "message_tool_results" (
	"tool_call_id" text PRIMARY KEY,
	"result" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_tool_results" ADD CONSTRAINT "message_tool_results_tool_call_id_message_tool_calls_id_fkey" FOREIGN KEY ("tool_call_id") REFERENCES "message_tool_calls"("id") ON DELETE CASCADE;