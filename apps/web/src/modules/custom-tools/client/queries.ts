import { queryOptions } from "@tanstack/react-query";
import { listUsableCustomTools } from "../server/functions.ts";

/** Attachable (enabled) custom tools for pickers; ids, slugs and labels only. */
export const usableCustomToolsQuery = queryOptions({
  queryKey: ["custom-tools", "usable"],
  queryFn: () => listUsableCustomTools(),
});
