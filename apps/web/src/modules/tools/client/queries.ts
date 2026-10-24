import { queryOptions } from "@tanstack/react-query";
import type { ToolSettingsInput } from "../schema.ts";
import { getScanReading, getToolSettings, listSearchProviders } from "../server/functions.ts";

const toolSettings = (tool: ToolSettingsInput["tool"]) => () => getToolSettings({ data: { tool } });

export const memoryToolQuery = queryOptions({
  queryKey: ["admin", "tools", "memory"],
  queryFn: toolSettings("memory"),
});

export const webSearchToolQuery = queryOptions({
  queryKey: ["admin", "tools", "web-search"],
  queryFn: toolSettings("web_search"),
});

export const urlReaderToolQuery = queryOptions({
  queryKey: ["admin", "tools", "url-reader"],
  queryFn: toolSettings("read_url"),
});

export const officeFilesToolQuery = queryOptions({
  queryKey: ["admin", "tools", "office-files"],
  queryFn: toolSettings("office_files"),
});

export const interactiveUiToolQuery = queryOptions({
  queryKey: ["admin", "tools", "interactive-ui"],
  queryFn: toolSettings("interactive_ui"),
});

export const mapsToolQuery = queryOptions({
  queryKey: ["admin", "tools", "maps"],
  queryFn: toolSettings("maps"),
});

export const searchProvidersQuery = queryOptions({
  queryKey: ["admin", "tools", "search-providers"],
  queryFn: () => listSearchProviders(),
});

export const imageGenerationToolQuery = queryOptions({
  queryKey: ["admin", "tools", "image-generation"],
  queryFn: toolSettings("image_generation"),
});

export const documentParserToolQuery = queryOptions({
  queryKey: ["admin", "tools", "document-parser"],
  queryFn: toolSettings("document_parser"),
});

export const scanReadingQuery = queryOptions({
  queryKey: ["admin", "tools", "scan-reading"],
  queryFn: () => getScanReading(),
  // The model files' download reports progress only when asked.
  refetchInterval: (query) =>
    Object.values(query.state.data?.localFiles ?? {}).some((file) => file.state === "downloading")
      ? 1000
      : false,
});
