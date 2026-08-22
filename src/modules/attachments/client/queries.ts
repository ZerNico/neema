import { queryOptions } from "@tanstack/react-query";
import { getDocumentParsingAvailability } from "../server/functions.ts";

// Lets the composer explain why a PDF chip is unusable: no native file support
// on the selected model AND no local parser to fall back on.
export const documentParsingAvailabilityQuery = queryOptions({
  queryKey: ["tools", "document-parsing", "availability"],
  queryFn: () => getDocumentParsingAvailability(),
  staleTime: 30_000,
});
