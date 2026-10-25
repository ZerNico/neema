-- An answer now names the ask_user call it answers. Older ones are matched as
-- the client used to: the finished answer just before them, past steers, that
-- presented exactly one batch, with no file on the reply. One that never
-- matched was always shown as a plain message, and becomes one.
WITH answered AS (
  SELECT reply.id AS message_id, max(ask.id) AS call_id
  FROM messages reply
  CROSS JOIN LATERAL (
    SELECT previous.id, previous.role, previous.status
    FROM messages previous
    WHERE previous.conversation_id = reply.conversation_id
      AND previous.steered_into_message_id IS NULL
      AND (previous.created_at, previous.id) < (reply.created_at, reply.id)
    ORDER BY previous.created_at DESC, previous.id DESC
    LIMIT 1
  ) previous
  JOIN message_tool_calls ask
    ON ask.message_id = previous.id
    AND ask.tool_name = 'ask_user'
    AND ask.status = 'complete'
    AND ask.result ->> 'outcome' = 'presented'
  WHERE reply.question_response IS NOT NULL
    AND reply.role = 'user'
    AND reply.status = 'complete'
    AND previous.role = 'assistant'
    AND previous.status = 'complete'
    AND NOT EXISTS (SELECT 1 FROM message_attachments a WHERE a.message_id = reply.id)
  GROUP BY reply.id
  HAVING count(*) = 1
)
UPDATE messages
SET question_response = jsonb_set(messages.question_response, '{callId}', to_jsonb(answered.call_id))
FROM answered
WHERE messages.id = answered.message_id
  AND NOT messages.question_response ? 'callId';
--> statement-breakpoint
UPDATE messages
SET question_response = NULL
WHERE question_response IS NOT NULL
  AND NOT question_response ? 'callId';
