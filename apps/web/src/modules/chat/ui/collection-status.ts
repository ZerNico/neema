import { m } from "~/paraglide/messages.js";
import type { CollectionSummary } from "~/modules/knowledge/schema.ts";

export const collectionStatus = (collection: CollectionSummary) =>
  collection.pendingCount > 0
    ? m.chat_collection_preparing({ count: collection.pendingCount })
    : collection.failedCount > 0
      ? m.chat_collection_failed({ count: collection.failedCount })
      : m.chat_collection_documents({ count: collection.documentCount });
