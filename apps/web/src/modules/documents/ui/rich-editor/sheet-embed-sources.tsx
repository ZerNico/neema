import type { Editor } from "@tiptap/core";
import { lazy, Suspense, useSyncExternalStore } from "react";
import { sheetEmbedHub } from "./sheet-embeds.ts";

// The sheet feed and the formula engine load with the first embed, not every document.
const SheetEmbedSource = lazy(() =>
  import("./sheet-embed-live.tsx").then((module) => ({ default: module.SheetEmbedSource })),
);

/**
 * One live source per sheet the editor's embeds show, mounted beside the
 * editor so it lives as long as the embeds are drawn.
 */
export function SheetEmbedSources({ editor }: { editor: Editor }) {
  const hub = sheetEmbedHub(editor);
  const ids = useSyncExternalStore(hub.subscribe, hub.ids, hub.ids);
  if (!ids.length) return null;
  return (
    <Suspense fallback={null}>
      {ids.map((sheetId) => (
        <SheetEmbedSource key={sheetId} hub={hub} sheetId={sheetId} />
      ))}
    </Suspense>
  );
}
