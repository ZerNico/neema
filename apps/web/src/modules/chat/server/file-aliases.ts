import { Effect } from "effect";
import { conversations } from "~/db/schema/index.ts";
import { ownedConversationById } from "./owned-conversation.ts";
import type { Db, DbTx } from "~/server/db.ts";

/**
 * The attachment id a reference means in this chat. A branch maps its
 * source's ids onto its own copies (docs/internals/files.md); the alias grants
 * nothing, the caller still checks the chat holds the result.
 */
export const currentAttachmentId = (
  db: DbTx | Db["Service"],
  chat: { readonly userId: string; readonly conversationId: string },
  requested: string,
) =>
  db
    .select({ aliases: conversations.fileReferenceAliases })
    .from(conversations)
    .where(ownedConversationById(chat.conversationId, chat.userId))
    .limit(1)
    .pipe(
      Effect.orDie,
      Effect.map(([row]) => row?.aliases?.attachments[requested] ?? requested),
    );
