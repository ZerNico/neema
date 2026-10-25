-- resolved_agent now records the agent's whole revision. Older rows lack some
-- of its keys; each missing one is filled from the agent's current rows, or
-- empty when the agent is gone. Keys a row already has are kept.
UPDATE message_generation_config c
SET resolved_agent = c.resolved_agent || jsonb_build_object(
  'skillIds', coalesce(
    c.resolved_agent -> 'skillIds',
    (SELECT jsonb_agg(s.skill_id ORDER BY s.position) FROM agent_skills s
      WHERE s.agent_id = c.resolved_agent ->> 'agentId'),
    '[]'::jsonb
  ),
  'customToolIds', coalesce(
    c.resolved_agent -> 'customToolIds',
    (SELECT jsonb_agg(t.tool_id ORDER BY t.position) FROM agent_custom_tools t
      WHERE t.agent_id = c.resolved_agent ->> 'agentId'),
    '[]'::jsonb
  ),
  'integrationIds', coalesce(
    c.resolved_agent -> 'integrationIds',
    (SELECT jsonb_agg(i.integration_id ORDER BY i.position) FROM agent_integrations i
      WHERE i.agent_id = c.resolved_agent ->> 'agentId'),
    '[]'::jsonb
  ),
  'imageModelId', coalesce(
    c.resolved_agent -> 'imageModelId',
    (SELECT to_jsonb(a.image_model_id) FROM agents a WHERE a.id = c.resolved_agent ->> 'agentId'),
    'null'::jsonb
  )
)
WHERE jsonb_typeof(c.resolved_agent) = 'object'
  AND (
    c.resolved_agent -> 'skillIds' IS NULL
    OR c.resolved_agent -> 'customToolIds' IS NULL
    OR c.resolved_agent -> 'integrationIds' IS NULL
    OR c.resolved_agent -> 'imageModelId' IS NULL
  );
