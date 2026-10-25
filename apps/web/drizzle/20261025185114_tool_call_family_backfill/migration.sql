-- Rows from before the family was stored: the family the client used to
-- infer from the tool name, a name it did not know being an old web row.
UPDATE "message_tool_calls"
SET "family" = CASE
  WHEN "tool_name" IN ('publish_file', 'create_file') THEN 'tool-file'
  WHEN "tool_name" = 'load_tools' THEN 'tool-load'
  WHEN "tool_name" = 'read_attachment' THEN 'attachment'
  WHEN "tool_name" IN ('read_history', 'search_chats', 'read_chat') THEN 'history'
  WHEN "tool_name" IN ('inspect_presentation', 'edit_presentation', 'render_presentation') THEN 'presentation'
  WHEN "tool_name" IN ('inspect_spreadsheet', 'edit_spreadsheet') THEN 'spreadsheet'
  WHEN "tool_name" IN ('inspect_word_file', 'edit_word_file') THEN 'word'
  WHEN "tool_name" IN ('draft_agent', 'read_agent_draft', 'list_agent_options', 'update_agent_draft') THEN 'agent-draft'
  WHEN "tool_name" IN ('draft_schedule', 'read_schedule_draft', 'update_schedule_draft') THEN 'schedule-draft'
  WHEN "tool_name" IN ('create_document', 'edit_document', 'read_chat_document', 'list_chat_documents', 'comment_on_document') THEN 'document'
  WHEN "tool_name" IN ('list_project_files', 'save_project_file') THEN 'project-file'
  WHEN "tool_name" IN ('list_knowledge_documents', 'search_knowledge', 'read_knowledge_document', 'knowledge_context') THEN 'knowledge'
  WHEN "tool_name" IN ('load_skill', 'read_skill_file') THEN 'skill'
  WHEN "tool_name" IN (
    'list_folder', 'find_files', 'search_files', 'read_local_file', 'import_local_file',
    'write_local_file', 'save_to_workspace', 'edit_local_file', 'move_local_file',
    'delete_local_file', 'run_command', 'request_network_access', 'request_path_access',
    'request_local_services', 'request_ssh_agent', 'browser_tabs', 'browser_open',
    'browser_navigate', 'browser_snapshot', 'browser_wait_for', 'browser_click',
    'browser_type', 'browser_press', 'browser_scroll', 'browser_select', 'browser_evaluate',
    'browser_save'
  ) THEN 'desktop'
  WHEN "tool_name" = 'generate_image' THEN 'image'
  WHEN "tool_name" = 'deep_research' THEN 'research'
  WHEN "tool_name" = 'ask_user' THEN 'ask'
  WHEN "tool_name" = 'map_route' THEN 'map'
  WHEN "tool_name" = 'notify_user' THEN 'notify'
  WHEN "tool_name" = 'update_plan' THEN 'plan'
  WHEN "tool_name" = 'save_memory' THEN 'memory'
  WHEN starts_with("tool_name", 'custom_') THEN 'custom'
  -- int_<integration>__<tool>, with a non-empty integration id.
  WHEN starts_with("tool_name", 'int_') AND position('__' IN substr("tool_name", 5)) > 1 THEN 'integration'
  ELSE 'web'
END
WHERE "family" IS NULL;
--> statement-breakpoint
ALTER TABLE "message_tool_calls" ALTER COLUMN "family" SET NOT NULL;
