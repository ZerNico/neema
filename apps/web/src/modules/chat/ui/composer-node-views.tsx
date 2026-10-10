import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { IntegrationTag } from "~/modules/integrations/ui/integration-mention-text.tsx";
import { inlineTagClassName } from "~/ui/inline-tag.ts";
import type { ContextTag } from "../tags.ts";
import type { IntegrationMentionOptions } from "./composer-doc.tsx";
import { ContextTagView } from "./message-tag.tsx";

export function MentionView({ node, extension }: NodeViewProps) {
  const id = node.attrs.integrationId as string;
  const icon = (extension.options as IntegrationMentionOptions).icon(id);
  if (icon)
    return (
      <NodeViewWrapper as="span" contentEditable={false}>
        <span className={inlineTagClassName("field")}>
          {icon}
          {/* The text keeps its "@" for the message; the tag shows only the name, as a sent one does. */}
          {(node.attrs.text as string).replace(/^@/u, "")}
        </span>
      </NodeViewWrapper>
    );
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
