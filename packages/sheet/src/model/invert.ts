import type { AxisEntry, Cell, Sheet, SheetDoc } from "./model.ts";
import type { CellWrite, SheetOp, StylePatch } from "./ops.ts";

const content = (cell: Cell | undefined) =>
  JSON.stringify([cell?.v ?? null, cell?.f ?? null, cell?.array ?? null]);
const styleOf = (key: string | undefined): Record<string, string | number | boolean> =>
  key ? (JSON.parse(key) as Record<string, string | number | boolean>) : {};

/** The patch that turns the style `now` into `wanted`. */
function restoreStyle(now: string | undefined, wanted: string | undefined): StylePatch {
  const [from, to] = [styleOf(now), styleOf(wanted)];
  const patch: Record<string, string | number | boolean | null> = {};
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)]))
    if (from[key] !== to[key]) patch[key] = to[key] ?? null;
  return patch;
}

const status = (entries: readonly AxisEntry[]) =>
  new Map(entries.map((entry) => [entry.id, !entry.dead]));
const previousLive = (entries: readonly AxisEntry[], id: string) => {
  const index = entries.findIndex((entry) => entry.id === id);
  for (let at = index - 1; at >= 0; at--) if (!entries[at]!.dead) return entries[at]!.id;
  return null;
};

const merges = (sheet: Sheet) => new Map(sheet.merges.map((box) => [JSON.stringify(box), box]));
const order = (doc: SheetDoc) =>
  doc.sheets
    .filter((entry) => !entry.dead)
    .map((entry) => entry.id)
    .join(" ");

/** How one sheet's rows or columns go back: inserted ones deleted, deleted ones revived. */
function axisUndo(sh: string, axis: "rows" | "columns", before: Sheet, after: Sheet) {
  const [was, is] = [
    status(axis === "rows" ? before.rows : before.cols),
    status(axis === "rows" ? after.rows : after.cols),
  ];
  const revive: string[] = [];
  const remove: string[] = [];
  for (const [id, alive] of is) {
    const then = was.get(id);
    if (alive && then !== true) remove.push(id);
    if (!alive && then === true) revive.push(id);
  }
  return {
    revive: revive.length ? [{ op: "revive" as const, sh, axis, ids: revive }] : [],
    remove: remove.length ? [{ op: "delete" as const, sh, axis, ids: remove }] : [],
  };
}

/** Cells whose content or style differ, restored to `before`; `now` keeps what others changed since. */
function cellsUndo(sh: string, before: Sheet, after: Sheet, now: Sheet | undefined): SheetOp[] {
  const writes: CellWrite[] = [];
  const styles: SheetOp[] = [];
  for (const r of new Set([...Object.keys(before.cells), ...Object.keys(after.cells)])) {
    const [old, next] = [before.cells[r], after.cells[r]];
    if (old === next) continue;
    for (const c of new Set([...Object.keys(old ?? {}), ...Object.keys(next ?? {})])) {
      const [was, is] = [old?.[c], next?.[c]];
      const current = now?.cells[r]?.[c];
      if (content(was) !== content(is) && content(current) === content(is))
        writes.push(
          was?.f
            ? { r, c, f: was.f, ...(was.array ? { array: was.array } : {}) }
            : { r, c, v: was?.v ?? null },
        );
      if (was?.s !== is?.s && current?.s === is?.s) {
        const patch = restoreStyle(is?.s, was?.s);
        styles.push({ op: "format", sh, area: { r1: r, r2: r, c1: c, c2: c }, patch });
      }
    }
  }
  return [...(writes.length ? [{ op: "set" as const, sh, cells: writes }] : []), ...styles];
}

/** Sizes, merges and frozen panes as they were. */
function layoutUndo(sh: string, before: Sheet, after: Sheet): SheetOp[] {
  const ops: SheetOp[] = [];
  for (const [axis, key] of [
    ["rows", "rowProps"],
    ["columns", "colProps"],
  ] as const)
    for (const id of new Set([...Object.keys(before[key]), ...Object.keys(after[key])])) {
      const [was, is] = [before[key][id], after[key][id]];
      if (was?.size !== is?.size)
        ops.push({ op: "resize", sh, axis, ids: [id], size: was?.size ?? null });
      if (!!was?.hidden !== !!is?.hidden)
        ops.push({ op: "hide", sh, axis, ids: [id], hidden: !!was?.hidden });
    }
  const [was, is] = [merges(before), merges(after)];
  for (const [key, box] of is) if (!was.has(key)) ops.push({ op: "unmerge", sh, box });
  for (const [key, box] of was) if (!is.has(key)) ops.push({ op: "merge", sh, box });
  if (before.freeze.row !== after.freeze.row || before.freeze.col !== after.freeze.col)
    ops.push({ op: "freeze", sh, ...before.freeze });
  if (JSON.stringify(before.filter ?? null) !== JSON.stringify(after.filter ?? null))
    ops.push({ op: "filter", sh, filter: before.filter ?? null });
  return ops;
}

/**
 * The operations that take `after` back to `before`, for undo. A cell is
 * put back only while `now` still holds what the change left there: undo
 * never takes back someone else's edit made since. Rows, columns and sheets
 * come back as marks, so anything anchored to them comes back too.
 */
export function invertChange(before: SheetDoc, after: SheetDoc, now: SheetDoc = after): SheetOp[] {
  const sheetsWere = status(before.sheets);
  const first: SheetOp[] = [];
  const middle: SheetOp[] = [];
  const last: SheetOp[] = [];
  for (const entry of after.sheets) {
    const id = entry.id;
    const was = sheetsWere.get(id);
    if (!entry.dead && was !== true) {
      last.push({ op: "sheetDelete", id });
      continue;
    }
    if (entry.dead && was === true) first.push({ op: "sheetRevive", id });
    const [old, next] = [before.sheet[id]!, after.sheet[id]!];
    if (old === next) continue;
    const rows = axisUndo(id, "rows", old, next);
    const cols = axisUndo(id, "columns", old, next);
    first.push(...rows.revive, ...cols.revive);
    middle.push(...cellsUndo(id, old, next, now.sheet[id]), ...layoutUndo(id, old, next));
    last.push(...rows.remove, ...cols.remove);
    if (old.name !== next.name) middle.push({ op: "sheetRename", id, name: old.name });
  }
  if (order(before) !== order(after))
    for (const entry of before.sheets)
      if (!entry.dead && after.sheet[entry.id])
        middle.push({
          op: "sheetMove",
          id: entry.id,
          after: previousLive(before.sheets, entry.id),
        });
  for (const key of new Set([...Object.keys(before.names), ...Object.keys(after.names)])) {
    const [was, is] = [before.names[key], after.names[key]];
    if (JSON.stringify(was) !== JSON.stringify(is))
      middle.push({ op: "name", name: was?.name ?? is!.name, f: was?.f ?? null });
  }
  for (const id of new Set([...Object.keys(before.charts), ...Object.keys(after.charts)])) {
    const [was, is] = [before.charts[id], after.charts[id]];
    if (JSON.stringify(was) !== JSON.stringify(is))
      middle.push(was ? { op: "chartPut", id, chart: was } : { op: "chartDelete", id });
  }
  for (const thread of new Set([...Object.keys(before.anchors), ...Object.keys(after.anchors)])) {
    const [was, is] = [before.anchors[thread], after.anchors[thread]];
    if (JSON.stringify(was) !== JSON.stringify(is))
      middle.push({ op: "anchor", thread, at: was ?? null });
  }
  if (JSON.stringify(before.settings) !== JSON.stringify(after.settings))
    middle.push({ op: "settings", ...before.settings });
  return [...first, ...middle, ...last];
}
