-- Writing markers named their attempt `runId`, which elsewhere means a research
-- run. The key is now `generationId`. Other chunks are plain text or carry a
-- research `runId`, so only writing rows are touched, and the cast runs in SET,
-- which Postgres evaluates only for the rows the WHERE kept.
UPDATE message_chunks
SET delta = ((delta::jsonb - 'runId') || jsonb_build_object('generationId', delta::jsonb -> 'runId'))::text
WHERE kind = 'writing' AND delta LIKE '%"runId":%';
