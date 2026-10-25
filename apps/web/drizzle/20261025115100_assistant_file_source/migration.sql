-- Files stored before `source` existed. A file with an origin came from a
-- tool call; one without was the model's own image.
UPDATE "messages"
SET "assistant_output" = jsonb_set(
  "assistant_output",
  '{files}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN file ? 'source' THEN file
        ELSE file || jsonb_build_object('source', CASE WHEN file ? 'origin' THEN 'tool' ELSE 'native' END)
      END
      ORDER BY position
    )
    FROM jsonb_array_elements("assistant_output" -> 'files') WITH ORDINALITY AS entry(file, position)
  )
)
WHERE jsonb_typeof("assistant_output" -> 'files') = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements("assistant_output" -> 'files') AS entry(file)
    WHERE NOT file ? 'source'
  );
--> statement-breakpoint
-- A failed answer can be resumed, which replays its chunks.
UPDATE "message_chunks"
SET "delta" = (
  "delta"::jsonb || jsonb_build_object(
    'source', CASE WHEN "delta"::jsonb ? 'origin' THEN 'tool' ELSE 'native' END
  )
)::text
WHERE "kind" = 'file' AND NOT "delta"::jsonb ? 'source';
