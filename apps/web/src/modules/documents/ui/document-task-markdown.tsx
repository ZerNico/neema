import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import type { MarkdownComponents } from "~/modules/chat/ui/assistant-markdown.tsx";
import { Checkbox } from "~/ui/primitives/checkbox.tsx";
import { cn } from "~/ui/utils";
import { TASK_ITEM } from "../task-items.ts";

const TASK_MARKER = "chat-document-task-";
const TaskOrdinalContext = createContext<number | null>(null);
const TaskToggleContext = createContext<(ordinal: number, checked: boolean) => void>(() => {});
const TaskDisabledContext = createContext(false);

export const renderedDocumentSource = (source: string) => {
  let ordinal = 0;
  return source
    .split("\n")
    .map((line) =>
      line.replace(TASK_ITEM, (_match, prefix: string, checked: string) => {
        const marker = `<span id="${TASK_MARKER}${ordinal++}"></span>`;
        return `${prefix}[${checked}] ${marker}`;
      }),
    )
    .join("\n");
};

const markerOrdinal = (node: unknown): number | null => {
  if (!node || typeof node !== "object") return null;
  if ("properties" in node && node.properties && typeof node.properties === "object") {
    const id = "id" in node.properties ? node.properties.id : null;
    if (typeof id === "string" && id.startsWith(TASK_MARKER)) {
      const ordinal = Number(id.slice(TASK_MARKER.length));
      if (Number.isSafeInteger(ordinal) && ordinal >= 0) return ordinal;
    }
  }
  if (!("children" in node) || !Array.isArray(node.children)) return null;
  for (const child of node.children) {
    const ordinal = markerOrdinal(child);
    if (ordinal !== null) return ordinal;
  }
  return null;
};

const DocumentListItem = ({
  node,
  className,
  ...props
}: ComponentProps<"li"> & { node?: unknown }) => {
  const ordinal = markerOrdinal(node);
  return (
    <TaskOrdinalContext.Provider value={ordinal}>
      {/* A task item carries its own box, so the list marker beside it would be
          a second bullet for the same thing. */}
      <li className={cn(className, ordinal !== null && "list-none")} {...props} />
    </TaskOrdinalContext.Provider>
  );
};
const DocumentMarker = ({
  node: _node,
  id,
  ...props
}: ComponentProps<"span"> & { node?: unknown }) =>
  typeof id === "string" && id.startsWith(TASK_MARKER) ? null : <span id={id} {...props} />;
/**
 * The app's checkbox, not the browser's. Markdown gives us an `<input>` whose
 * `checked` is the source line itself, so this stays fully controlled: the
 * primitive never keeps its own state, and a rejected toggle simply re-renders
 * from the source that did not change.
 */
const DocumentTaskCheckbox = ({
  node: _node,
  disabled: _disabled,
  checked,
  ...props
}: ComponentProps<"input"> & { node?: unknown }) => {
  const ordinal = useContext(TaskOrdinalContext);
  const toggleTask = useContext(TaskToggleContext);
  const disabled = useContext(TaskDisabledContext);
  if (props.type !== "checkbox" || ordinal === null)
    return <input disabled checked={checked} {...props} />;
  return (
    <Checkbox
      checked={checked === true}
      disabled={disabled}
      // Markdown puts the box inside the item's own text flow; nudge it onto
      // the first line rather than letting it sit on the baseline.
      className="mr-1 inline-flex cursor-pointer translate-y-[0.1875rem] align-top"
      onCheckedChange={(next) => toggleTask(ordinal, next)}
    />
  );
};

export const documentTaskMarkdownComponents: MarkdownComponents = {
  li: DocumentListItem,
  span: DocumentMarker,
  input: DocumentTaskCheckbox,
};

/**
 * Streamdown memoizes blocks by identity and strips the source positions a
 * checkbox would need, so the ordinal reaches the input through context rather
 * than props, and the marker spans above are what carry it through nested and
 * loose list items.
 */
export function DocumentTaskScope({
  children,
  disabled,
  onToggle,
}: {
  children: ReactNode;
  disabled: boolean;
  onToggle: (ordinal: number, checked: boolean) => void;
}) {
  return (
    <TaskDisabledContext.Provider value={disabled}>
      <TaskToggleContext.Provider value={onToggle}>{children}</TaskToggleContext.Provider>
    </TaskDisabledContext.Provider>
  );
}
