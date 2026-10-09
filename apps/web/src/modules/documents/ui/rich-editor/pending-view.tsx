import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { cn } from "~/ui/utils";

/** A planned section, waiting for the assistant to write it. */
export function PendingView({ node, selected }: ReactNodeViewProps) {
  const intent = String(node.attrs.intent ?? "");
  return (
    <NodeViewWrapper
      data-pending=""
      contentEditable={false}
      className={cn(
        "border-border my-3 flex items-baseline gap-2 rounded-lg border border-dashed px-3 py-2 text-sm select-none",
        selected && "ring-ring/50 ring-2",
      )}
    >
      <span className="text-muted-foreground shrink-0 text-xs font-medium">Planned</span>
      <span className="text-shimmer min-w-0">{intent || "Section"}</span>
    </NodeViewWrapper>
  );
}
