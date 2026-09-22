CREATE TABLE "agent_custom_tools" (
	"agent_id" text,
	"tool_id" text,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "agent_custom_tools_pkey" PRIMARY KEY("agent_id","tool_id")
);
--> statement-breakpoint
CREATE TABLE "custom_tool_group_grants" (
	"tool_id" text,
	"group_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_tool_group_grants_pkey" PRIMARY KEY("tool_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "custom_tool_user_grants" (
	"tool_id" text,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_tool_user_grants_pkey" PRIMARY KEY("tool_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "custom_tools" (
	"id" text PRIMARY KEY,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"source" text NOT NULL,
	"dependencies" jsonb DEFAULT '[]' NOT NULL,
	"compiled" text NOT NULL,
	"functions" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"audience" text DEFAULT 'instance' NOT NULL,
	"version" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "custom_tools_slug_idx" ON "custom_tools" ("slug");--> statement-breakpoint
ALTER TABLE "agent_custom_tools" ADD CONSTRAINT "agent_custom_tools_agent_id_agents_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_custom_tools" ADD CONSTRAINT "agent_custom_tools_tool_id_custom_tools_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "custom_tools"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "custom_tool_group_grants" ADD CONSTRAINT "custom_tool_group_grants_tool_id_custom_tools_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "custom_tools"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "custom_tool_group_grants" ADD CONSTRAINT "custom_tool_group_grants_group_id_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "custom_tool_user_grants" ADD CONSTRAINT "custom_tool_user_grants_tool_id_custom_tools_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "custom_tools"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "custom_tool_user_grants" ADD CONSTRAINT "custom_tool_user_grants_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "custom_tools" ADD CONSTRAINT "custom_tools_created_by_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL;