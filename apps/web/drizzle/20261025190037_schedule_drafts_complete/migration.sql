-- Schedule drafts once left out settings that meant "keep what is saved" when
-- absent. Complete them from the schedule they edit, or with a new schedule's
-- defaults, and record that schedule's revision as the one their save must find.
WITH grants AS (
  SELECT g.schedule_id,
    jsonb_agg(
      jsonb_strip_nulls(jsonb_build_object(
        'connectionId', g.connection_id,
        'integrationId', g.integration_id,
        'access', g.access,
        'allowances', g.allowances
      )) || jsonb_build_object('connectionId', g.connection_id, 'integrationId', g.integration_id)
      ORDER BY g.integration_id, g.connection_id NULLS LAST
    ) AS list
  FROM schedule_integration_grants g
  GROUP BY g.schedule_id
),
stored AS (
  SELECT s.id, s.config_revision,
    jsonb_build_object(
      'chatMode', s.chat_mode,
      'chatId', s.chat_id,
      'imageModelId', s.image_model_id,
      'notify', s.notify,
      'integrationGrants', coalesce(grants.list, '[]'::jsonb)
    ) AS settings
  FROM schedules s
  LEFT JOIN grants ON grants.schedule_id = s.id
)
-- A draft that named its chat mode meant no chat by leaving the chat out.
UPDATE conversation_drafts d
SET settings = coalesce(stored.settings, jsonb_build_object(
      'chatMode', 'new',
      'chatId', null,
      'imageModelId', null,
      'notify', 'always',
      'integrationGrants', '[]'::jsonb
    ))
    || CASE WHEN d.settings ? 'chatMode' THEN '{"chatId": null}'::jsonb ELSE '{}'::jsonb END
    || d.settings,
  target_revision = coalesce(d.target_revision, stored.config_revision)
FROM conversation_drafts self
LEFT JOIN stored ON stored.id = self.target_id
WHERE self.id = d.id AND d.kind = 'schedule';
