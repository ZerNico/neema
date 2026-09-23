ALTER TABLE "group_members" ADD COLUMN "share_agents" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "group_members" ADD COLUMN "share_knowledge" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "group_members" ADD COLUMN "share_skills" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "group_members" SET "share_agents" = "can_share", "share_knowledge" = "can_share", "share_skills" = "can_share";--> statement-breakpoint
ALTER TABLE "group_members" DROP COLUMN "can_share";