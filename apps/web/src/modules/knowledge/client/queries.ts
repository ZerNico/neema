import { queryOptions } from "@tanstack/react-query";
import {
  getEmbeddingConfiguration,
  getKnowledgeCollection,
  listKnowledgeCollections,
} from "../server/functions.ts";

export const knowledgeCollectionsQuery = queryOptions({
  queryKey: ["knowledge", "collections"],
  queryFn: () => listKnowledgeCollections(),
  staleTime: 30_000,
});

export const knowledgeCollectionQuery = (collectionId: string) =>
  queryOptions({
    queryKey: ["knowledge", "collection", collectionId],
    queryFn: () => getKnowledgeCollection({ data: { collectionId } }),
    // Indexing progress changes underneath the page; sync invalidates it too.
    staleTime: 10_000,
  });

export const embeddingConfigurationQuery = queryOptions({
  queryKey: ["admin", "tools", "embeddings"],
  queryFn: () => getEmbeddingConfiguration(),
});
