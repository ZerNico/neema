import { queryOptions } from "@tanstack/react-query";
import {
  getDocumentParserTool,
  getMemoryTool,
  getOfficeFilesTool,
  getScanReading,
  getUrlReaderTool,
  getWebSearchTool,
  listSearchProviders,
} from "../server/functions.ts";

export const memoryToolQuery = queryOptions({
  queryKey: ["admin", "tools", "memory"],
  queryFn: () => getMemoryTool(),
});

export const webSearchToolQuery = queryOptions({
  queryKey: ["admin", "tools", "web-search"],
  queryFn: () => getWebSearchTool(),
});

export const urlReaderToolQuery = queryOptions({
  queryKey: ["admin", "tools", "url-reader"],
  queryFn: () => getUrlReaderTool(),
});

export const officeFilesToolQuery = queryOptions({
  queryKey: ["admin", "tools", "office-files"],
  queryFn: () => getOfficeFilesTool(),
});

export const searchProvidersQuery = queryOptions({
  queryKey: ["admin", "tools", "search-providers"],
  queryFn: () => listSearchProviders(),
});

export const documentParserToolQuery = queryOptions({
  queryKey: ["admin", "tools", "document-parser"],
  queryFn: () => getDocumentParserTool(),
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
