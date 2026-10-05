import { useCallback } from "react";
import type { DocumentSource } from "~/modules/tools/source-schema.ts";
import { sourceIdentity } from "~/modules/tools/sources.ts";
import { useDetailPanel } from "~/ui/detail-panel-context.ts";
import { DocumentSourcePanel } from "./document-source-panel.tsx";

export function useDocumentSourcePanel(source: DocumentSource) {
  const panel = useDetailPanel();
  return useCallback(() => {
    const id = `document-source:${sourceIdentity(source)}`;
    panel.open({
      id,
      title: source.title || "Document source",
      body: <DocumentSourcePanel key={crypto.randomUUID()} source={source} />,
    });
  }, [panel, source]);
}
