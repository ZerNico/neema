import type { CollectionSummary } from "~/modules/knowledge/schema.ts";

export const collectionStatus = (collection: CollectionSummary) =>
  collection.pendingCount > 0
    ? `${collection.pendingCount} preparing`
    : collection.failedCount > 0
      ? `${collection.failedCount} failed`
      : `${collection.documentCount} docs`;
