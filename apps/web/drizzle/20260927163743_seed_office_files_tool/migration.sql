-- Seed the office_files tool row: whether chats are offered the tools that
-- create and edit PowerPoint files. Like read_url it needs no external service,
-- so it ships enabled. updateTool only patches existing rows, so the row must exist.
INSERT INTO "tools" ("id", "name", "kind", "enabled", "config")
VALUES (
  '01a0f3c0-0ff1-7000-8000-5e1f0ff1ce01',
  'office_files',
  'office_files',
  true,
  '{}'
)
ON CONFLICT ("name") DO NOTHING;
