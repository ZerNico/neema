import { defineRelations } from "drizzle-orm";
import * as schema from "./schema/index.ts";

export const relations = defineRelations(schema, (r) => ({
  user: {
    conversations: r.many.conversations(),
    sessions: r.many.session(),
    attachments: r.many.attachments(),
    attachmentBlobs: r.many.attachmentBlobs(),
    groupMemberships: r.many.groupMembers(),
    usageEvents: r.many.usageEvents(),
    memorySettings: r.one.memorySettings({
      from: r.user.id,
      to: r.memorySettings.userId,
    }),
    memories: r.many.memories(),
  },
  memorySettings: {
    user: r.one.user({
      from: r.memorySettings.userId,
      to: r.user.id,
      optional: false,
    }),
  },
  memories: {
    user: r.one.user({
      from: r.memories.userId,
      to: r.user.id,
      optional: false,
    }),
    sourceConversation: r.one.conversations({
      from: r.memories.sourceConversationId,
      to: r.conversations.id,
    }),
    sourceMessage: r.one.messages({
      from: r.memories.sourceMessageId,
      to: r.messages.id,
    }),
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
    sourceMemories: r.many.memories(),
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
    sourceMemories: r.many.memories(),
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
    groupAccess: r.many.modelGroupAccess(),
    usageEvents: r.many.usageEvents(),
  },
  groups: {
    members: r.many.groupMembers(),
    modelAccess: r.many.modelGroupAccess(),
  },
  groupMembers: {
    group: r.one.groups({
      from: r.groupMembers.groupId,
      to: r.groups.id,
      optional: false,
    }),
    user: r.one.user({
      from: r.groupMembers.userId,
      to: r.user.id,
      optional: false,
    }),
  },
  usageEvents: {
    user: r.one.user({
      from: r.usageEvents.userId,
      to: r.user.id,
      optional: false,
    }),
    model: r.one.models({
      from: r.usageEvents.modelId,
      to: r.models.id,
    }),
  },
  modelGroupAccess: {
    model: r.one.models({
      from: r.modelGroupAccess.modelId,
      to: r.models.id,
      optional: false,
    }),
    group: r.one.groups({
      from: r.modelGroupAccess.groupId,
      to: r.groups.id,
      optional: false,
    }),
  },
}));
