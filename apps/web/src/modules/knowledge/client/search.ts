import { FolderLibraryIcon } from "@hugeicons/core-free-icons";
import { listSource } from "~/modules/search/registry.ts";
import { knowledgeCollectionsQuery } from "./queries.ts";

export const useCollectionSearch = listSource({
  heading: "Knowledge",
  icon: FolderLibraryIcon,
  query: knowledgeCollectionsQuery,
  allowed: (capabilities) => capabilities.knowledgeUse,
  text: (collection) => collection.description,
  detail: (collection) => collection.description || undefined,
  href: (collection) => `/knowledge/${collection.id}`,
});
