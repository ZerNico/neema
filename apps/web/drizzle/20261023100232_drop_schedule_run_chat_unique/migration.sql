-- A same-chat schedule records every run in its one chat. The first schedules
-- migration added this constraint in SQL alone, so the schema never had it and
-- each fire after a chat's first failed on it.
ALTER TABLE "schedule_runs" DROP CONSTRAINT IF EXISTS "schedule_runs_conversation_id_unique";
