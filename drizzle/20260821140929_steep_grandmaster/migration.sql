CREATE TABLE "message_tool_calls" (
	"id" text PRIMARY KEY,
	"message_id" text NOT NULL,
	"turn_index" integer NOT NULL,
	"call_index" integer NOT NULL,
	"provider_call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"arguments" jsonb NOT NULL,
	"result" jsonb,
	"status" text NOT NULL,
	"error" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tools" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"config" jsonb NOT NULL,
	"secret_ciphertext" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "message_tool_calls_message_id_idx" ON "message_tool_calls" ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_tool_calls_turn_call_idx" ON "message_tool_calls" ("message_id","turn_index","call_index");--> statement-breakpoint
CREATE UNIQUE INDEX "tools_name_idx" ON "tools" ("name");--> statement-breakpoint
ALTER TABLE "message_tool_calls" ADD CONSTRAINT "message_tool_calls_message_id_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE;--> statement-breakpoint
INSERT INTO "tools" ("id", "name", "kind", "enabled", "config")
VALUES (
	'01a024a7-da32-7215-97c2-d228971a39c7',
	'web_search',
	'web_search',
	false,
	'{"backend":"searxng","baseUrl":"http://localhost:8081","maxResults":8,"maxPagesFetched":3,"perPageCharCap":12000}'
)
ON CONFLICT ("name") DO NOTHING;