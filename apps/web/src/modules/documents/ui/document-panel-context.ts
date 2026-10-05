import { createContext, useContext } from "react";

export interface DocumentPanelEntry {
  title: string | null;
  status: string;
  /** Rendered as the card's meta line, so the transcript shows checklist progress. */
  tasks: { done: number; total: number } | null;
  /** Shared with the project rather than kept in this chat; null until loaded. */
  inProject: boolean | null;
  chars: number;
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
