import { TaskItem } from "@tiptap/extension-list";
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type ReactNodeViewProps,
} from "@tiptap/react";
import { Checkbox } from "~/ui/primitives/checkbox";

function TaskItemView({ node, editor, updateAttributes }: ReactNodeViewProps) {
  const checked = node.attrs.checked === true;
  return (
    <NodeViewWrapper as="li" data-type="taskItem" data-checked={checked}>
      <span contentEditable={false} className="task-item-check">
        <Checkbox
          checked={checked}
          disabled={!editor.isEditable}
          aria-label={checked ? "Mark as not done" : "Mark as done"}
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

/**
 * The task item drawn with the app's own checkbox. Only the browser's view
 * changes: the node, and so the Markdown, stay the shared schema's.
 */
export const DocumentTaskItem = TaskItem.extend({
  addNodeView() {
    return ReactNodeViewRenderer(TaskItemView);
  },
}).configure({ nested: true });
