CREATE TABLE "tool_call_debug_arguments" (
	"tool_call_id" text PRIMARY KEY,
	"arguments" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tool_call_debug_arguments" ADD CONSTRAINT "tool_call_debug_arguments_auuGmvMqEFE1_fkey" FOREIGN KEY ("tool_call_id") REFERENCES "message_tool_calls"("id") ON DELETE CASCADE;