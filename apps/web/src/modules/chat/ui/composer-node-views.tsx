import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { IntegrationTag } from "~/modules/integrations/ui/integration-mention-text.tsx";
import type { ContextTag } from "../tags.ts";
import { ContextTagView } from "./message-tag.tsx";

export function MentionView({ node }: NodeViewProps) {
  return (
    <NodeViewWrapper as="span" contentEditable={false}>
      <IntegrationTag
        integrationId={node.attrs.integrationId as string}
        fallback={node.attrs.text as string}
        tone="field"
      />
    </NodeViewWrapper>
  );
}

export function ContextTagNodeView({ node }: NodeViewProps) {
  return (
    <NodeViewWrapper as="span" contentEditable={false}>
      <ContextTagView tag={node.attrs as ContextTag} tone="field" />
    </NodeViewWrapper>
  );
}
