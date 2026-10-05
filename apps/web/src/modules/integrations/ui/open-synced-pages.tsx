import type { DetailPanelApi } from "~/ui/detail-panel.tsx";
import { SyncedPagesPanel } from "./synced-pages-panel.tsx";

/** Opens the side panel listing what one source brought into a collection. */
export const openSyncedPages = (
  panel: DetailPanelApi,
  collectionId: string,
  sourceId: string,
  title: string,
) =>
  panel.open({
    id: `synced-pages:${sourceId}`,
    title,
    body: (
      <SyncedPagesPanel
        collectionId={collectionId}
        sourceId={sourceId}
        title={title}
        onBack={() => openSyncedPages(panel, collectionId, sourceId, title)}
      />
    ),
  });
