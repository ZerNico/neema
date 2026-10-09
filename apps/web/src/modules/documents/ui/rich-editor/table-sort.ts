import type { Editor } from "@tiptap/core";
import { Fragment, type Node } from "@tiptap/pm/model";
import { isInTable, selectedRect } from "@tiptap/pm/tables";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Orders the table's rows below its header row, or all of them in a table
 * without one, by the column the cursor is in,
 * numbers by value and words alphabetically; empty cells go last. Tables
 * here never merge cells (Markdown has no spans), so a row's cell index is
 * its column.
 */
export const sortColumn = (editor: Editor, direction: 1 | -1) => {
  const { state } = editor;
  if (!isInTable(state)) return;
  const rect = selectedRect(state);
  const rows: Node[] = [];
  rect.table.forEach((row) => rows.push(row));
  const headed = rows[0]?.firstChild?.type.name === "tableHeader";
  const header = headed ? rows.slice(0, 1) : [];
  const body = headed ? rows.slice(1) : rows;
  if (body.length < 2) return;
  const key = (row: Node) =>
    rect.left < row.childCount ? row.child(rect.left).textContent.trim() : "";
  const sorted = body.toSorted((a, b) => {
    const [left, right] = [key(a), key(b)];
    if (!left || !right) return Number(!left) - Number(!right);
    return direction * collator.compare(left, right);
  });
  if (sorted.every((row, index) => row === body[index])) return;
  const start = rect.tableStart - 1;
  editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.replaceWith(
        start,
        start + rect.table.nodeSize,
        rect.table.copy(Fragment.from([...header, ...sorted])),
      );
      return true;
    })
    .run();
};
