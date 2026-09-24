-- Search, see docs/internals/search.md. Both extensions ship with Postgres contrib.
CREATE EXTENSION IF NOT EXISTS unaccent;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
-- `simple` stems no language, so every language is treated alike; `unaccent`
-- lets "grossen" find "Größen". Named, because an index may only use immutable
-- expressions and `unaccent()` itself is not one.
CREATE TEXT SEARCH CONFIGURATION app_search (COPY = simple);--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION app_search ALTER MAPPING FOR hword, hword_part, word WITH unaccent, simple;--> statement-breakpoint
CREATE INDEX "conversations_title_trgm_idx" ON "conversations" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "messages_search_idx" ON "messages" USING gin (to_tsvector('app_search'::regconfig, "content"));