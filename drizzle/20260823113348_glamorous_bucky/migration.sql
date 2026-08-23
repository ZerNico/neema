CREATE TABLE "group_members" (
	"group_id" text,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_members_pkey" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL UNIQUE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_group_access" (
	"model_id" text,
	"group_id" text,
	CONSTRAINT "model_group_access_pkey" PRIMARY KEY("model_id","group_id")
);
--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "access" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
CREATE INDEX "group_members_user_id_idx" ON "group_members" ("user_id");--> statement-breakpoint
CREATE INDEX "model_group_access_group_id_idx" ON "model_group_access" ("group_id");--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "model_group_access" ADD CONSTRAINT "model_group_access_model_id_models_id_fkey" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "model_group_access" ADD CONSTRAINT "model_group_access_group_id_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE;