import { queryOptions } from "@tanstack/react-query";
import { getCustomTool, listCustomTools, listUsableCustomTools } from "../server/functions.ts";
import { settled } from "./settled.ts";

/** Attachable (enabled) custom tools for pickers; ids, slugs and labels only. */
export const usableCustomToolsQuery = queryOptions({
  queryKey: ["custom-tools", "usable"],
  queryFn: () => listUsableCustomTools(),
});

export const customToolQuery = (toolId: string) =>
  queryOptions({
    queryKey: ["admin", "custom-tools", toolId],
    queryFn: () => settled(getCustomTool({ data: { toolId } })),
  });

export const customToolsQuery = queryOptions({
  queryKey: ["admin", "custom-tools"],
  queryFn: () => listCustomTools(),
});
