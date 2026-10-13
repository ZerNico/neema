import { queryOptions } from "@tanstack/react-query";
import { getImageGenerationTool, listImageModels } from "../server/functions.ts";

export const imageGenerationToolQuery = queryOptions({
  queryKey: ["admin", "tools", "image-generation"],
  queryFn: () => getImageGenerationTool(),
});

/** What this person may draw with, in the admin's order; empty while switched off. */
export const imageModelsQuery = queryOptions({
  queryKey: ["image-models"],
  queryFn: () => listImageModels(),
  staleTime: 60_000,
});
