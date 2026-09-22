CREATE TABLE "user_seen_features" (
	"user_id" text,
	"feature_key" text,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_seen_features_pkey" PRIMARY KEY("user_id","feature_key")
);
--> statement-breakpoint
ALTER TABLE "user_seen_features" ADD CONSTRAINT "user_seen_features_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;