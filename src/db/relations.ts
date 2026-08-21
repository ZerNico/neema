import { defineRelations } from "drizzle-orm";
import * as schema from "./schema/index.ts";

export const relations = defineRelations(schema, (r) => ({
  user: {
    conversations: r.many.conversations(),
    sessions: r.many.session(),
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
