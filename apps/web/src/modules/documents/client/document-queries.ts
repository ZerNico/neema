import { queryOptions } from "@tanstack/react-query";
import { getDocument } from "../server/document-functions.ts";

export const documentQuery = (documentId: string) =>
  queryOptions({
    queryKey: ["documents", documentId],
    queryFn: () => getDocument({ data: { documentId } }),
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
