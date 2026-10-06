CREATE TABLE "integration_allowance_uses" (
	"message_id" text,
	"integration_id" text,
	"allowance_id" text,
	"uses" integer NOT NULL,
	CONSTRAINT "integration_allowance_uses_pkey" PRIMARY KEY("message_id","integration_id","allowance_id")
);
--> statement-breakpoint
ALTER TABLE "integration_allowance_uses" ADD CONSTRAINT "integration_allowance_uses_message_id_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE;