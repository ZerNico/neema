import { TaskItem } from "@tiptap/extension-list";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { TaskItemView } from "./task-item-view.tsx";

/**
 * The task item drawn with the app's own checkbox. Only the browser's view
 * changes: the node, and so the Markdown, stay the shared schema's.
 */
export const DocumentTaskItem = TaskItem.extend({
  addNodeView() {
    return ReactNodeViewRenderer(TaskItemView);
  },
}).configure({ nested: true });
