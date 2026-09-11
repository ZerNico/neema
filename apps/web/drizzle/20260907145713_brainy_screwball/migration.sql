-- Semantic search stores vectors; the extension must exist before the column.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "agent_collections" (
	"agent_id" text,
	"collection_id" text,
	"position" integer NOT NULL,
	CONSTRAINT "agent_collections_pkey" PRIMARY KEY("agent_id","collection_id")
);
--> statement-breakpoint
CREATE TABLE "agent_group_grants" (
	"agent_id" text,
	"group_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_group_grants_pkey" PRIMARY KEY("agent_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "agent_user_grants" (
	"agent_id" text,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_user_grants_pkey" PRIMARY KEY("agent_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"icon" text DEFAULT 'robot' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"model_id" text,
	"search_enabled" boolean DEFAULT false NOT NULL,
	"plan_enabled" boolean DEFAULT false NOT NULL,
	"starters" jsonb DEFAULT '[]' NOT NULL,
	"audience" text DEFAULT 'private' NOT NULL,
	"config_revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_agents" (
	"conversation_id" text PRIMARY KEY,
	"agent_id" text,
	"snapshot" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_generation_config" (
	"message_id" text PRIMARY KEY,
	"agent_id" text,
	"snapshot" jsonb,
	"knowledge_mode" text DEFAULT 'none' NOT NULL,
	"plan_enabled" boolean DEFAULT false NOT NULL,
	"search_enabled" boolean DEFAULT false NOT NULL,
	"collection_ids" jsonb DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blob_cleanup_intents" (
	"storage_key" text PRIMARY KEY,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_chunk_embeddings" (
	"chunk_id" text PRIMARY KEY,
	"version_id" text NOT NULL,
	"space_id" text NOT NULL,
	"dimensions" integer NOT NULL,
	"embedding" vector NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" text PRIMARY KEY,
	"version_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"content" text NOT NULL,
	"heading_path" text DEFAULT '' NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	"page" integer,
	"tokens" integer NOT NULL,
	"search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce("knowledge_chunks"."heading_path", '') || ' ' || "knowledge_chunks"."content")) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_collection_group_grants" (
	"collection_id" text,
	"group_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_collection_group_grants_pkey" PRIMARY KEY("collection_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "knowledge_collection_user_grants" (
	"collection_id" text,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_collection_user_grants_pkey" PRIMARY KEY("collection_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "knowledge_collections" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"audience" text DEFAULT 'private' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_document_versions" (
	"id" text PRIMARY KEY,
	"document_id" text NOT NULL,
	"revision" integer NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"chunker_revision" integer,
	"pipeline_fingerprint" text,
	"kind" text NOT NULL,
	"blob_id" text,
	"file_name" text,
	"media_type" text,
	"byte_size" integer,
	"note_content" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"text" text,
	"page_count" integer,
	"char_count" integer,
	"truncated" jsonb,
	"error" text,
	"lease_token" text,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"id" text PRIMARY KEY,
	"collection_id" text NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"current_version_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_embedding_jobs" (
	"version_id" text PRIMARY KEY,
	"space_id" text NOT NULL,
	"connection_revision" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"lease_token" text,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_knowledge_versions" (
	"message_id" text,
	"version_id" text,
	"document_id" text,
	"collection_id" text NOT NULL,
	"status" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"char_count" integer,
	"truncated" boolean DEFAULT false NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "message_knowledge_versions_pkey" PRIMARY KEY("message_id","document_id")
);
--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "members_can_share" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_collections_collection_idx" ON "agent_collections" ("collection_id");--> statement-breakpoint
CREATE INDEX "agent_group_grants_group_idx" ON "agent_group_grants" ("group_id");--> statement-breakpoint
CREATE INDEX "agent_user_grants_user_idx" ON "agent_user_grants" ("user_id");--> statement-breakpoint
CREATE INDEX "agents_user_id_idx" ON "agents" ("user_id");--> statement-breakpoint
CREATE INDEX "blob_cleanup_intents_due_idx" ON "blob_cleanup_intents" ("not_before");--> statement-breakpoint
CREATE INDEX "knowledge_chunk_embeddings_version_space_idx" ON "knowledge_chunk_embeddings" ("version_id","space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_chunks_version_ordinal_idx" ON "knowledge_chunks" ("version_id","ordinal");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_search_idx" ON "knowledge_chunks" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "knowledge_collection_group_grants_group_idx" ON "knowledge_collection_group_grants" ("group_id");--> statement-breakpoint
CREATE INDEX "knowledge_collection_user_grants_user_idx" ON "knowledge_collection_user_grants" ("user_id");--> statement-breakpoint
CREATE INDEX "knowledge_collections_user_id_idx" ON "knowledge_collections" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_document_versions_revision_idx" ON "knowledge_document_versions" ("document_id","revision");--> statement-breakpoint
CREATE INDEX "knowledge_document_versions_blob_idx" ON "knowledge_document_versions" ("blob_id");--> statement-breakpoint
CREATE INDEX "knowledge_document_versions_claim_idx" ON "knowledge_document_versions" ("lease_until") WHERE "status" in ('queued', 'extracting');--> statement-breakpoint
CREATE INDEX "knowledge_documents_collection_idx" ON "knowledge_documents" ("collection_id");--> statement-breakpoint
CREATE INDEX "knowledge_documents_current_version_idx" ON "knowledge_documents" ("current_version_id");--> statement-breakpoint
CREATE INDEX "knowledge_embedding_jobs_claim_idx" ON "knowledge_embedding_jobs" ("lease_until") WHERE "status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "message_knowledge_versions_version_idx" ON "message_knowledge_versions" ("version_id");--> statement-breakpoint
ALTER TABLE "agent_collections" ADD CONSTRAINT "agent_collections_agent_id_agents_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_group_grants" ADD CONSTRAINT "agent_group_grants_agent_id_agents_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_group_grants" ADD CONSTRAINT "agent_group_grants_group_id_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_user_grants" ADD CONSTRAINT "agent_user_grants_agent_id_agents_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_user_grants" ADD CONSTRAINT "agent_user_grants_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "conversation_agents" ADD CONSTRAINT "conversation_agents_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "conversation_agents" ADD CONSTRAINT "conversation_agents_agent_id_agents_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "message_generation_config" ADD CONSTRAINT "message_generation_config_message_id_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "message_generation_config" ADD CONSTRAINT "message_generation_config_agent_id_agents_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "knowledge_chunk_embeddings" ADD CONSTRAINT "knowledge_chunk_embeddings_chunk_id_knowledge_chunks_id_fkey" FOREIGN KEY ("chunk_id") REFERENCES "knowledge_chunks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_chunk_embeddings" ADD CONSTRAINT "knowledge_chunk_embeddings_mBK917oUajGR_fkey" FOREIGN KEY ("version_id") REFERENCES "knowledge_document_versions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_version_id_knowledge_document_versions_id_fkey" FOREIGN KEY ("version_id") REFERENCES "knowledge_document_versions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_collection_group_grants" ADD CONSTRAINT "knowledge_collection_group_grants_79cI9Qah2fnJ_fkey" FOREIGN KEY ("collection_id") REFERENCES "knowledge_collections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_collection_group_grants" ADD CONSTRAINT "knowledge_collection_group_grants_group_id_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_collection_user_grants" ADD CONSTRAINT "knowledge_collection_user_grants_KJ0WB94v2MQZ_fkey" FOREIGN KEY ("collection_id") REFERENCES "knowledge_collections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_collection_user_grants" ADD CONSTRAINT "knowledge_collection_user_grants_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_collections" ADD CONSTRAINT "knowledge_collections_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_document_versions" ADD CONSTRAINT "knowledge_document_versions_afaz7oz4h4Uu_fkey" FOREIGN KEY ("document_id") REFERENCES "knowledge_documents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_document_versions" ADD CONSTRAINT "knowledge_document_versions_blob_id_attachment_blobs_id_fkey" FOREIGN KEY ("blob_id") REFERENCES "attachment_blobs"("id") DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_collection_id_knowledge_collections_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "knowledge_collections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_7p92GN8Gef4n_fkey" FOREIGN KEY ("current_version_id") REFERENCES "knowledge_document_versions"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "knowledge_embedding_jobs" ADD CONSTRAINT "knowledge_embedding_jobs_HxwoOXg7ZOSL_fkey" FOREIGN KEY ("version_id") REFERENCES "knowledge_document_versions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "message_knowledge_versions" ADD CONSTRAINT "message_knowledge_versions_message_id_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE;--> statement-breakpoint
-- Semantic search is opt-in; collections otherwise use lexical search and reads.
INSERT INTO "tools" ("id", "name", "kind", "enabled", "config")
VALUES (
  '01a04100-7c3d-7000-8000-4b2e9c1d5a02',
  'knowledge_search',
  'embeddings',
  false,
  '{"spaceId":null,"embeddingModelId":null,"dimensions":null,"connectionRevision":null,"approvedConnection":null}'
);
