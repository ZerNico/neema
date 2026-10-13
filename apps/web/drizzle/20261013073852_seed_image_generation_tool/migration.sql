-- Seed the image generation tool row: whether chats are offered generate_image
-- at all. Ships enabled; nothing is offered until an admin adds an image model.
-- updateTool only patches existing rows, so the row must exist.
INSERT INTO "tools" ("id", "name", "kind", "enabled", "config")
VALUES (
  '01a11c40-0000-7000-8000-1e7e0c71e003',
  'image_generation',
  'image_generation',
  true,
  '{}'
)
ON CONFLICT ("name") DO NOTHING;
