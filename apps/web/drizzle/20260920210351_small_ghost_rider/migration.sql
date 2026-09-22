CREATE TABLE "work_turn_reservations" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"intent" text NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"assistant_message_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "work_turn_reservations_user_id_idx" ON "work_turn_reservations" ("user_id");--> statement-breakpoint
CREATE INDEX "work_turn_reservations_expiry_idx" ON "work_turn_reservations" ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "work_turn_reservations_live_conversation_idx" ON "work_turn_reservations" ("conversation_id") WHERE "status" = 'reserved';--> statement-breakpoint
ALTER TABLE "work_turn_reservations" ADD CONSTRAINT "work_turn_reservations_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;