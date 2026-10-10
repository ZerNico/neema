import { createContext, useContext } from "react";

export interface DocumentPanelEntry {
  title: string | null;
  status: string;
  /** Shared with the project rather than kept in this chat; null until loaded. */
  inProject: boolean | null;
  expanded: boolean;
  open: (() => void) | null;
  retry: (() => void) | null;
}

export interface DocumentPanelScope {
  owned: ReadonlySet<string>;
  gone: ReadonlySet<string>;
  entries: ReadonlyMap<string, DocumentPanelEntry>;
}
export const EMPTY_DOCUMENT_IDS = new Set<string>();
export const DocumentPanelContext = createContext<DocumentPanelScope>({
  owned: EMPTY_DOCUMENT_IDS,
  gone: EMPTY_DOCUMENT_IDS,
  entries: new Map(),
});

export const useDocumentPanel = (documentId: string) => {
  const scope = useContext(DocumentPanelContext);
  return {
    owned: scope.owned.has(documentId),
    gone: scope.gone.has(documentId),
    entry: scope.entries.get(documentId) ?? null,
  };
};
