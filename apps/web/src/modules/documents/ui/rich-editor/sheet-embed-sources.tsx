import type { Editor } from "@tiptap/core";
import { Component, lazy, Suspense, useSyncExternalStore, type ReactNode } from "react";
import { sheetEmbedHub, type SheetEmbedHub } from "./sheet-embeds.ts";

// The sheet feed and the formula engine load with the first embed, not every document.
const SheetEmbedSource = lazy(() =>
  import("./sheet-embed-live.tsx").then((module) => ({ default: module.SheetEmbedSource })),
);

/**
 * Contains a source that fails to load (its chunk gone after a deploy, the
 * network down): every embed it would feed shows as unavailable, and the
 * document around them stays usable.
 */
class SourcesBoundary extends Component<
  { hub: SheetEmbedHub; ids: readonly string[]; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch() {
    for (const sheetId of this.props.ids)
      this.props.hub.publish(sheetId, {
        status: "unavailable",
        title: null,
        doc: null,
        values: null,
      });
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * One live source per sheet the editor's embeds show, mounted beside the
 * editor so it lives as long as the embeds are drawn.
 */
export function SheetEmbedSources({ editor }: { editor: Editor }) {
  const hub = sheetEmbedHub(editor);
  const ids = useSyncExternalStore(hub.subscribe, hub.ids, hub.ids);
  if (!ids.length) return null;
  return (
    <SourcesBoundary hub={hub} ids={ids}>
      <Suspense fallback={null}>
        {ids.map((sheetId) => (
          <SheetEmbedSource key={sheetId} hub={hub} sheetId={sheetId} />
        ))}
      </Suspense>
    </SourcesBoundary>
  );
}
