import { queryOptions } from "@tanstack/react-query";
import { getDocument, listProjectDocuments } from "../server/document-functions.ts";

export const documentQuery = (documentId: string) =>
  queryOptions({
    queryKey: ["documents", documentId],
    queryFn: () => getDocument({ data: { documentId } }),
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

/** Under the project key, so a project's change hint refreshes it with the rest. */
export const projectDocumentsQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", "documents", projectId],
    queryFn: () => listProjectDocuments({ data: { projectId } }),
    staleTime: 30_000,
  });
