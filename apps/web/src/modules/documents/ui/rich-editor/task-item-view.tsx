import { m } from "~/paraglide/messages.js";
import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { Checkbox } from "~/ui/primitives/checkbox";

export function TaskItemView({ node, editor, updateAttributes }: ReactNodeViewProps) {
  const checked = node.attrs.checked === true;
  return (
    <NodeViewWrapper as="li" data-type="taskItem" data-checked={checked}>
      <span contentEditable={false} className="task-item-check">
        <Checkbox
          checked={checked}
          disabled={!editor.isEditable}
          aria-label={checked ? m.documents_task_mark_open() : m.documents_task_mark_done()}
          // Read at the click: access can end while the view stays mounted,
          // and a node view's change goes through even when the editor is read-only.
          onCheckedChange={(next) => {
            if (editor.isEditable) updateAttributes({ checked: next });
          }}
        />
      </span>
      <NodeViewContent className="task-item-body" />
    </NodeViewWrapper>
  );
}
