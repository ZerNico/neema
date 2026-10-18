DROP INDEX "messages_streaming_lease_idx";--> statement-breakpoint
CREATE INDEX "conversation_agents_agent_id_idx" ON "conversation_agents" ("agent_id");--> statement-breakpoint
CREATE INDEX "message_generation_config_agent_id_idx" ON "message_generation_config" ("agent_id");--> statement-breakpoint
CREATE INDEX "compaction_checkpoints_model_idx" ON "conversation_compaction_checkpoints" ("model_id") WHERE "model_id" is not null;--> statement-breakpoint
CREATE INDEX "conversations_model_idx" ON "conversations" ("model_id") WHERE "model_id" is not null;--> statement-breakpoint
CREATE INDEX "conversations_image_model_idx" ON "conversations" ("image_model_id") WHERE "image_model_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_model_idx" ON "messages" ("model_id") WHERE "model_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_streaming_idx" ON "messages" ("conversation_id") WHERE "status" = 'streaming';--> statement-breakpoint
CREATE INDEX "documents_created_by_message_idx" ON "documents" ("created_by_message_id") WHERE "created_by_message_id" is not null;--> statement-breakpoint
CREATE INDEX "research_calls_task_idx" ON "research_calls" ("task_id") WHERE "task_id" is not null;--> statement-breakpoint
CREATE INDEX "research_runs_conversation_idx" ON "research_runs" ("conversation_id");--> statement-breakpoint
CREATE INDEX "schedule_runs_conversation_idx" ON "schedule_runs" ("conversation_id");--> statement-breakpoint
CREATE INDEX "skill_revisions_baseline_idx" ON "skill_revisions" ("baseline_revision_id");