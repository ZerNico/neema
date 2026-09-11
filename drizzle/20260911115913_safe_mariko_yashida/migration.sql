CREATE TABLE "oauth_providers" (
	"id" text PRIMARY KEY,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_ciphertext" text,
	"config" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
