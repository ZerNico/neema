-- read_project_file is gone: a project file is read through read_attachment.
-- Its old rows become reads of that tool, keeping what the row ever held
-- (whether it worked, and which file), so history shows them as file reads.
UPDATE "message_tool_calls"
SET
  "tool_name" = 'read_attachment',
  "result" = CASE
    WHEN "result" IS NULL THEN NULL
    ELSE jsonb_strip_nulls(jsonb_build_object(
      'ok', ("result" ->> 'outcome') = 'read',
      'fileName', "result" -> 'fileName',
      'error', CASE WHEN ("result" ->> 'outcome') = 'read' THEN NULL ELSE "result" -> 'message' END
    ))
  END
WHERE "tool_name" = 'read_project_file';
