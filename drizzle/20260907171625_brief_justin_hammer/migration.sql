ALTER TABLE "group_members" ADD COLUMN "can_share" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" DROP COLUMN "members_can_share";