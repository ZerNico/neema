-- Nullable until the next migration backfills existing rows and requires it.
ALTER TABLE "message_tool_calls" ADD COLUMN "family" text;
