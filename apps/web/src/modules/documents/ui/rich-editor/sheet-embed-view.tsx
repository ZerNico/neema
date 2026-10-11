import { FileSpreadsheetIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { Component, lazy, Suspense, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { embedAttrs, embedCaption } from "../../editor/sheet-embed.ts";
import { editorHooks } from "./editor-hooks.ts";
import { sheetEmbedHub } from "./sheet-embeds.ts";

// The sheet model and its number formats load with the first embed drawn.
const SheetEmbedBody = lazy(() =>
  import("./sheet-embed-live.tsx").then((module) => ({ default: module.SheetEmbedBody })),
);

/** Keeps a failure drawing one embed inside it, so the rest of the document still shows. */
class EmbedBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <Quiet>This sheet couldn’t be shown</Quiet> : this.props.children;
  }
}

function Quiet({ children }: { children: string }) {
  return <p className="text-muted-foreground text-sm">{children}</p>;
}

/**
 * An embedded range or chart, drawn from its sheet as it is now. It holds
 * the sheet in the editor's hub while drawn; the hub's one source per sheet
 * reads and calculates it for every embed of it.
 */
export function SheetEmbedView({ node, editor, selected }: ReactNodeViewProps) {
  const attrs = embedAttrs(node.attrs);
  const sheetId = attrs?.sheet ?? "";
  const hub = sheetEmbedHub(editor);
  useEffect(() => (sheetId ? hub.acquire(sheetId) : undefined), [hub, sheetId]);
  const source = useSyncExternalStore(
    hub.subscribe,
    () => hub.source(sheetId),
    () => hub.source(sheetId),
  );
  const open = editorHooks(editor).opener(sheetId);
  const what = attrs?.range ?? (attrs?.chart ? "Chart" : "");
  const caption =
    source.status === "unavailable" || !attrs
      ? (attrs && embedCaption(attrs)) || "Sheet"
      : `${source.title ?? "Sheet"} · ${what}`;
  return (
    <NodeViewWrapper
      contentEditable={false}
      data-sheet-embed-view=""
      data-sheet={attrs?.sheet}
      data-range={attrs?.range ?? undefined}
      data-chart={attrs?.chart ?? undefined}
      data-selected={selected || undefined}
      className="sheet-embed"
    >
      {open && source.status === "ready" ? (
        <button
          type="button"
          className="sheet-embed-caption hover:text-foreground"
          // Opening the sheet must not first move the caret onto the embed.
          onMouseDown={(event) => event.preventDefault()}
          onClick={open}
        >
          <HugeiconsIcon icon={FileSpreadsheetIcon} strokeWidth={2} />
          <span className="truncate">{caption}</span>
        </button>
      ) : (
        <p className="sheet-embed-caption">
          <HugeiconsIcon icon={FileSpreadsheetIcon} strokeWidth={2} />
          <span className="truncate">{caption}</span>
        </p>
      )}
      {!attrs || source.status === "unavailable" ? (
        <Quiet>This sheet isn’t available</Quiet>
      ) : source.status === "loading" || !source.doc || !source.values ? (
        <Quiet>Loading sheet…</Quiet>
      ) : (
        <EmbedBoundary>
          <Suspense fallback={<Quiet>Loading sheet…</Quiet>}>
            <SheetEmbedBody
              doc={source.doc}
              values={source.values}
              range={attrs.range}
              chart={attrs.chart}
            />
          </Suspense>
        </EmbedBoundary>
      )}
    </NodeViewWrapper>
  );
}
