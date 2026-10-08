-- Seed the interactive_ui tool row: whether answers may contain ```ui blocks
-- and whether their image tags are looked up. Like office_files it ships
-- enabled. updateTool only patches existing rows, so the row must exist.
INSERT INTO "tools" ("id", "name", "kind", "enabled", "config")
VALUES (
  '01a11c40-0000-7000-8000-1e7e0c71e001',
  'interactive_ui',
  'interactive_ui',
  true,
  '{"images": true}'
)
ON CONFLICT ("name") DO NOTHING;
