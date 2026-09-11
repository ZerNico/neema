-- Seed the read_url tool row. Like document_parser and unlike web_search it
-- needs no external service to be stood up first, so it ships enabled.
-- updateTool only patches existing rows, so the row must exist. Config
-- mirrors web_search's per-page character cap.
INSERT INTO "tools" ("id", "name", "kind", "enabled", "config")
VALUES (
  '01a03000-5c1e-7000-8000-1f7d2b9c4e01',
  'read_url',
  'url_reader',
  true,
  '{"perPageCharCap":12000}'
)
ON CONFLICT ("name") DO NOTHING;
