import { defineRelations } from "drizzle-orm";
import * as schema from "./schema/index.ts";

export const relations = defineRelations(schema, (r) => ({
  user: {
    conversations: r.many.conversations(),
    sessions: r.many.session(),
    attachments: r.many.attachments(),
    attachmentBlobs: r.many.attachmentBlobs(),
  },
  session: {
    user: r.one.user({
      from: r.session.userId,
      to: r.user.id,
      optional: false,
    }),
  },
  conversations: {
    user: r.one.user({
      from: r.conversations.userId,
      to: r.user.id,
      optional: false,
    }),
    model: r.one.models({
      from: r.conversations.modelId,
      to: r.models.id,
    }),
    messages: r.many.messages(),
  },
  messages: {
    conversation: r.one.conversations({
      from: r.messages.conversationId,
      to: r.conversations.id,
      optional: false,
    }),
    model: r.one.models({
      from: r.messages.modelId,
      to: r.models.id,
    }),
    chunks: r.many.messageChunks(),
    toolCalls: r.many.messageToolCalls(),
    attachments: r.many.messageAttachments(),
  },
  messageChunks: {
    message: r.one.messages({
      from: r.messageChunks.messageId,
      to: r.messages.id,
      optional: false,
    }),
  },
  messageToolCalls: {
    message: r.one.messages({
      from: r.messageToolCalls.messageId,
      to: r.messages.id,
      optional: false,
    }),
  },
  attachmentBlobs: {
    user: r.one.user({
      from: r.attachmentBlobs.userId,
      to: r.user.id,
      optional: false,
    }),
    attachments: r.many.attachments(),
  },
  attachments: {
    user: r.one.user({
      from: r.attachments.userId,
      to: r.user.id,
      optional: false,
    }),
    blob: r.one.attachmentBlobs({
      from: r.attachments.blobId,
      to: r.attachmentBlobs.id,
      optional: false,
    }),
    messageLink: r.one.messageAttachments({
      from: r.attachments.id,
      to: r.messageAttachments.attachmentId,
    }),
  },
  messageAttachments: {
    message: r.one.messages({
      from: r.messageAttachments.messageId,
      to: r.messages.id,
      optional: false,
    }),
    attachment: r.one.attachments({
      from: r.messageAttachments.attachmentId,
      to: r.attachments.id,
      optional: false,
    }),
  },
  providers: {
    models: r.many.models(),
  },
  models: {
    provider: r.one.providers({
      from: r.models.providerId,
      to: r.providers.id,
      optional: false,
    }),
  },
}));
