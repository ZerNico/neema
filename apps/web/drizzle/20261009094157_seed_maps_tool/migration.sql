-- Seed the maps tool row: whether places and routes are looked up, for the
-- route tool in any chat and the maps interactive answers draw, and which
-- services do it. Ships enabled with the public OpenStreetMap services, which
-- settings.ts fills in for an empty config. updateTool only patches existing
-- rows, so the row must exist.
INSERT INTO "tools" ("id", "name", "kind", "enabled", "config")
VALUES (
  '01a11c40-0000-7000-8000-1e7e0c71e002',
  'maps',
  'maps',
  true,
  '{}'
)
ON CONFLICT ("name") DO NOTHING;
