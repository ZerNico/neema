import { queryOptions } from "@tanstack/react-query";
import {
  getDocument,
  getDocumentSharing,
  listDocumentLibrary,
  listProjectDocuments,
} from "../server/document-functions.ts";

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

/** Under the documents key, so any change to a person's document refreshes it. */
export const documentLibraryQuery = queryOptions({
  queryKey: ["documents", "library"],
  queryFn: () => listDocumentLibrary(),
  staleTime: 30_000,
});

/** Under the document's key, so its change event refreshes who it is shared with too. */
export const documentSharingQuery = (documentId: string) =>
  queryOptions({
    queryKey: ["documents", documentId, "sharing"],
    queryFn: () => getDocumentSharing({ data: { documentId } }),
  });
