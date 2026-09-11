import { queryOptions } from "@tanstack/react-query";
import { getMemorySettings, listMemories } from "../server/functions.ts";

export const memorySettingsQuery = queryOptions({
  queryKey: ["memory", "settings"],
  queryFn: () => getMemorySettings(),
  staleTime: 30_000,
});

export const memoriesQuery = queryOptions({
  queryKey: ["memory", "list"],
  queryFn: () => listMemories(),
  staleTime: 30_000,
});
