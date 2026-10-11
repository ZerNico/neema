import { EditorState } from "@tiptap/pm/state";
import { fixTables } from "@tiptap/pm/tables";
import type { Transform } from "@tiptap/pm/transform";

/**
 * Fills out a table whose rows have fewer cells than its widest, as every
 * open editor's table plugin would on seeing it. Done once by the writer, or
 * each editor adds the cells itself, as that person's edit, racing the others.
 */
export const squareTables = <T extends Transform>(tr: T): T => {
  const fix = fixTables(EditorState.create({ doc: tr.doc }));
  if (fix) for (const step of fix.steps) tr.step(step);
  return tr;
};
