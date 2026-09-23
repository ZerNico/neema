CREATE TABLE "agent_integrations" (
	"agent_id" text,
	"integration_id" text,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "agent_integrations_pkey" PRIMARY KEY("agent_id","integration_id")
);
--> statement-breakpoint
CREATE TABLE "conversation_integrations" (
	"conversation_id" text,
	"integration_id" text,
	"enabled" boolean,
	"allowed_tools" jsonb DEFAULT '[]' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_integrations_pkey" PRIMARY KEY("conversation_id","integration_id")
);
--> statement-breakpoint
CREATE TABLE "integration_configs" (
	"id" text PRIMARY KEY,
	"enabled" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}' NOT NULL,
	"oauth_client_id" text,
	"oauth_client_secret_ciphertext" text,
	"allow_api_keys" boolean DEFAULT true NOT NULL,
	"audience" text DEFAULT 'instance' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_connections" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"auth_kind" text NOT NULL,
	"credentials_ciphertext" text NOT NULL,
	"account_label" text NOT NULL,
	"config_fingerprint" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"offer_by_default" boolean DEFAULT true NOT NULL,
	"tool_permissions" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_group_grants" (
	"integration_id" text,
	"group_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_group_grants_pkey" PRIMARY KEY("integration_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "integration_user_grants" (
	"integration_id" text,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_user_grants_pkey" PRIMARY KEY("integration_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "knowledge_sources" (
	"id" text PRIMARY KEY,
	"collection_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"root" jsonb NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"last_error" text,
	"last_synced_at" timestamp with time zone,
	"cursor" timestamp with time zone,
	"full_synced_at" timestamp with time zone,
	"oversized" jsonb DEFAULT '{}' NOT NULL,
	"next_sync_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stats" jsonb,
	"lease_token" text,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_generation_config" ADD COLUMN "integration_grants" jsonb;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "source_id" text;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "external_url" text;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "external_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "integration_grants" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_integrations_integration_idx" ON "agent_integrations" ("integration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_connections_user_idx" ON "integration_connections" ("user_id","integration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_documents_source_external_idx" ON "knowledge_documents" ("source_id","external_id");--> statement-breakpoint
CREATE INDEX "knowledge_sources_collection_idx" ON "knowledge_sources" ("collection_id");--> statement-breakpoint
CREATE INDEX "knowledge_sources_due_idx" ON "knowledge_sources" ("next_sync_at");--> statement-breakpoint
ALTER TABLE "agent_integrations" ADD CONSTRAINT "agent_integrations_agent_id_agents_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "conversation_integrations" ADD CONSTRAINT "conversation_integrations_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_jlVRZ2WewDNA_fkey" FOREIGN KEY ("integration_id") REFERENCES "integration_configs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "integration_group_grants" ADD CONSTRAINT "integration_group_grants_YvbCOHay0QHk_fkey" FOREIGN KEY ("integration_id") REFERENCES "integration_configs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "integration_group_grants" ADD CONSTRAINT "integration_group_grants_group_id_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "integration_user_grants" ADD CONSTRAINT "integration_user_grants_VFXycPjCNb4I_fkey" FOREIGN KEY ("integration_id") REFERENCES "integration_configs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "integration_user_grants" ADD CONSTRAINT "integration_user_grants_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_source_id_knowledge_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "knowledge_sources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_collection_id_knowledge_collections_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "knowledge_collections"("id") ON DELETE CASCADE;