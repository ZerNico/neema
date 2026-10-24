import { queryOptions } from "@tanstack/react-query";
import { listImageModels } from "../server/functions.ts";

/** What this person may draw with, in the admin's order; empty while switched off. */
export const imageModelsQuery = queryOptions({
  queryKey: ["image-models"],
  queryFn: () => listImageModels(),
  staleTime: 60_000,
});
