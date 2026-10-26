CREATE TABLE "machines" (
	"id" text,
	"user_id" text,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machines_pkey" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "network_grants" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"conversation_id" text,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"private_network" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "network_grants_destination_key" UNIQUE NULLS NOT DISTINCT("user_id","conversation_id","host","port")
);
--> statement-breakpoint
DROP TABLE "work_turn_reservations";--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "machine_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "computer_folders" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN "mode";--> statement-breakpoint
ALTER TABLE "message_generation_config" DROP COLUMN "desktop_commands";--> statement-breakpoint
ALTER TABLE "message_generation_config" DROP COLUMN "desktop_folders";--> statement-breakpoint
ALTER TABLE "message_generation_config" DROP COLUMN "desktop_machine_id";--> statement-breakpoint
ALTER TABLE "message_generation_config" DROP COLUMN "desktop_machine_name";--> statement-breakpoint
ALTER TABLE "message_generation_config" DROP COLUMN "workspace_files";--> statement-breakpoint
-- Reads no longer ask: the VM bounds what they reach. Auto-approving everything stays allowed.
UPDATE "conversations" SET "permission_level" = CASE WHEN "permission_level" = 'skip' THEN 'allow' ELSE 'ask' END;--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "permission_level" SET DEFAULT 'ask';--> statement-breakpoint
CREATE INDEX "network_grants_conversation_idx" ON "network_grants" ("conversation_id") WHERE "conversation_id" is not null;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "network_grants" ADD CONSTRAINT "network_grants_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "network_grants" ADD CONSTRAINT "network_grants_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE;