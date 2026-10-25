-- Sessions from before the mark existed were told apart by the shell's user
-- agent token. Marked once from it here; from now on only redemption marks one.
UPDATE "session" SET "desktop" = true WHERE "user_agent" LIKE '%ChatDesktop/%';
