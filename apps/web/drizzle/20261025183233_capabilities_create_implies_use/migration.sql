-- Readers used to treat Create as implying Use. A row with Create but not Use
-- (only possible by hand) keeps the access it had by turning Use on, before
-- the check constraint that follows refuses such rows.
UPDATE "groups" SET "capabilities" = "capabilities"
  || CASE WHEN coalesce(("capabilities" ->> 'agentsCreate')::boolean, false) THEN '{"agentsUse": true}'::jsonb ELSE '{}'::jsonb END
  || CASE WHEN coalesce(("capabilities" ->> 'knowledgeCreate')::boolean, false) THEN '{"knowledgeUse": true}'::jsonb ELSE '{}'::jsonb END
  || CASE WHEN coalesce(("capabilities" ->> 'skillsCreate')::boolean, false) THEN '{"skillsUse": true}'::jsonb ELSE '{}'::jsonb END
  || CASE WHEN coalesce(("capabilities" ->> 'projectsCreate')::boolean, false) THEN '{"projectsUse": true}'::jsonb ELSE '{}'::jsonb END;
--> statement-breakpoint
UPDATE "default_capabilities" SET "capabilities" = "capabilities"
  || CASE WHEN coalesce(("capabilities" ->> 'agentsCreate')::boolean, false) THEN '{"agentsUse": true}'::jsonb ELSE '{}'::jsonb END
  || CASE WHEN coalesce(("capabilities" ->> 'knowledgeCreate')::boolean, false) THEN '{"knowledgeUse": true}'::jsonb ELSE '{}'::jsonb END
  || CASE WHEN coalesce(("capabilities" ->> 'skillsCreate')::boolean, false) THEN '{"skillsUse": true}'::jsonb ELSE '{}'::jsonb END
  || CASE WHEN coalesce(("capabilities" ->> 'projectsCreate')::boolean, false) THEN '{"projectsUse": true}'::jsonb ELSE '{}'::jsonb END;
