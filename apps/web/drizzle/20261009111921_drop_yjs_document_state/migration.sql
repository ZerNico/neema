-- Documents move from Yjs to ProseMirror steps; old documents are not converted.
DELETE FROM "documents";--> statement-breakpoint
DROP TABLE "document_updates";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "snapshot";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "snapshot_revision";