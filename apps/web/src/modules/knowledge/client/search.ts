import { FolderLibraryIcon } from "@hugeicons/core-free-icons";
import { listSource } from "~/modules/search/registry.ts";
import { knowledgeCollectionsQuery } from "./queries.ts";
import { m } from "~/paraglide/messages.js";

export const useCollectionSearch = listSource({
  // A getter, so the heading is read in the page's language when shown.
  get heading() {
    return m.knowledge_title();
  },
  icon: FolderLibraryIcon,
  query: knowledgeCollectionsQuery,
  allowed: (capabilities) => capabilities.knowledgeUse,
  text: (collection) => collection.description,
  detail: (collection) => collection.description || undefined,
  href: (collection) => `/knowledge/${collection.id}`,
});
