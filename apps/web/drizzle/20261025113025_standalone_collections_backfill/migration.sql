-- Rows from before standalone_collection_ids recorded only the effective set.
-- The person's own are what the attempt's agent did not bring; for later rows
-- that set is already contained in the column, so this changes nothing there.
WITH missing AS (
  SELECT c.message_id, jsonb_agg(e.id ORDER BY e.ord) AS ids
  FROM message_generation_config c
  CROSS JOIN LATERAL jsonb_array_elements(c.collection_ids) WITH ORDINALITY AS e(id, ord)
  WHERE NOT coalesce(c.resolved_agent -> 'collectionIds', '[]'::jsonb) @> jsonb_build_array(e.id)
    AND NOT c.standalone_collection_ids @> jsonb_build_array(e.id)
  GROUP BY c.message_id
)
UPDATE message_generation_config c
SET standalone_collection_ids = c.standalone_collection_ids || missing.ids
FROM missing
WHERE c.message_id = missing.message_id;
