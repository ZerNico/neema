import { applyChange } from "./apply.ts";
import { mergeFields, type ChartPatch } from "./chart.ts";
import type { SheetImage } from "./image.ts";
import type { AxisEntry, Cell, Chart, Sheet, SheetDoc } from "./model.ts";
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

/** Whether two plain values hold the same, as stored documents compare. */
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * A list kept by item, as it goes back: items the change added leave, items
 * it removed return, items it changed revert, each only while `now` still has
 * what the change left. What others did to the list since stays.
 */
function listUndo<T>(
  before: readonly T[],
  after: readonly T[],
  now: readonly T[],
  idOf: (item: T) => string,
): T[] | null {
  const [was, is] = [
    new Map(before.map((item) => [idOf(item), item])),
    new Map(after.map((item) => [idOf(item), item])),
  ];
  const kept = now.flatMap((item): T[] => {
    const id = idOf(item);
    const [then, left] = [was.get(id), is.get(id)];
    if (!left || !same(item, left)) return [item];
    if (!then) return [];
    return [then];
  });
  const present = new Set(kept.map(idOf));
  before.forEach((item, index) => {
    const id = idOf(item);
    if (!is.has(id) && !present.has(id)) kept.splice(Math.min(index, kept.length), 0, item);
  });
  return same(kept, now) ? null : kept;
}

/** Sizes, merges, panes, rules and filter as they were, where `now` still has what the change left. */
function layoutUndo(sh: string, before: Sheet, after: Sheet, now: Sheet): SheetOp[] {
  const ops: SheetOp[] = [];
  for (const [axis, key] of [
    ["rows", "rowProps"],
    ["columns", "colProps"],
  ] as const)
    for (const id of new Set([...Object.keys(before[key]), ...Object.keys(after[key])])) {
      const [was, is, current] = [before[key][id], after[key][id], now[key][id]];
      if (was?.size !== is?.size && current?.size === is?.size)
        ops.push({ op: "resize", sh, axis, ids: [id], size: was?.size ?? null });
      if (!!was?.hidden !== !!is?.hidden && !!current?.hidden === !!is?.hidden)
        ops.push({ op: "hide", sh, axis, ids: [id], hidden: !!was?.hidden });
    }
  const [was, is, current] = [merges(before), merges(after), merges(now)];
  for (const [key, box] of is)
    if (!was.has(key) && current.has(key)) ops.push({ op: "unmerge", sh, box });
  for (const [key, box] of was)
    if (!is.has(key) && !current.has(key)) ops.push({ op: "merge", sh, box });
  if (!same(before.freeze, after.freeze) && same(now.freeze, after.freeze))
    ops.push({ op: "freeze", sh, ...before.freeze });
  for (const [axis, key] of [
    ["rows", "rows"],
    ["columns", "cols"],
  ] as const) {
    const list = listUndo(
      before.outline?.[key] ?? [],
      after.outline?.[key] ?? [],
      now.outline?.[key] ?? [],
      (group) => `${group.from}|${group.to}`,
    );
    if (list) ops.push({ op: "outline", sh, axis, list });
  }
  const validations = listUndo(
    before.validations ?? [],
    after.validations ?? [],
    now.validations ?? [],
    (rule) => rule.id,
  );
  if (validations) ops.push({ op: "validations", sh, list: validations });
  const conditional = listUndo(
    before.conditional ?? [],
    after.conditional ?? [],
    now.conditional ?? [],
    (rule) => rule.id,
  );
  if (conditional) ops.push({ op: "conditional", sh, list: conditional });
  if (!same(before.filter, after.filter) && same(now.filter, after.filter))
    ops.push({ op: "filter", sh, filter: before.filter ?? null });
  return ops;
}

/** Fields of an object as they were, where `now` still has what the change left: others' fields stay. */
function fieldsUndo<T extends object>(
  before: T,
  after: T,
  now: T,
): Partial<Record<keyof T, unknown>> {
  const patch: Partial<Record<keyof T, unknown>> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)]) as Set<keyof T>)
    if (!same(before[key], after[key]) && same(now[key], after[key]))
      patch[key] = before[key] ?? null;
  return patch;
}

/** A chart put back field by field, axes and style one level down as `chartPatch` merges them. */
function chartUndo(
  id: string,
  before: Chart | undefined,
  after: Chart | undefined,
  now: Chart | undefined,
): SheetOp[] {
  if (same(before, after)) return [];
  // Added by the change: removed while nobody has changed it since. Removed: back while still gone.
  if (!before) return after && same(now, after) ? [{ op: "chartDelete", id }] : [];
  if (!after) return now ? [] : [{ op: "chartPut", id, chart: before }];
  if (!now) return [];
  const { axes: _a, style: _s, ...top } = fieldsUndo(before, after, now);
  const axes = fieldsUndo(before.axes ?? {}, after.axes ?? {}, now.axes ?? {});
  const style = fieldsUndo(before.style ?? {}, after.style ?? {}, now.style ?? {});
  const patch = {
    ...top,
    ...(Object.keys(axes).length ? { axes } : {}),
    ...(Object.keys(style).length ? { style } : {}),
  } as ChartPatch;
  return Object.keys(patch).length ? [{ op: "chartPatch", id, patch }] : [];
}

/** A picture put back field by field, whole as `imagePut` writes it. */
function imageUndo(
  id: string,
  before: SheetImage | undefined,
  after: SheetImage | undefined,
  now: SheetImage | undefined,
): SheetOp[] {
  if (same(before, after)) return [];
  if (!before) return after && same(now, after) ? [{ op: "imageDelete", id }] : [];
  if (!after) return now ? [] : [{ op: "imagePut", id, image: before }];
  if (!now) return [];
  const changes = fieldsUndo(before, after, now);
  if (!Object.keys(changes).length) return [];
  return [{ op: "imagePut", id, image: mergeFields(now, changes) }];
}

/**
 * The operations that take `after` back to `before`, for undo. Anything is
 * put back only while `now` still holds what the change left there: undo
 * never takes back someone else's edit made since, to a cell, a size, a
 * rule, a chart's field or anything else. Rows, columns and sheets come back
 * as marks, so anything anchored to them comes back too.
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
    const current = now.sheet[id] ?? next;
    const rows = axisUndo(id, "rows", old, next);
    const cols = axisUndo(id, "columns", old, next);
    first.push(...rows.revive, ...cols.revive);
    middle.push(...cellsUndo(id, old, next, current), ...layoutUndo(id, old, next, current));
    last.push(...rows.remove, ...cols.remove);
    if (old.name !== next.name && current.name === next.name)
      middle.push({ op: "sheetRename", id, name: old.name });
    if (old.color !== next.color && current.color === next.color)
      middle.push({ op: "sheetColor", id, color: old.color ?? null });
  }
  if (order(before) !== order(after) && order(now) === order(after))
    for (const entry of before.sheets)
      if (!entry.dead && after.sheet[entry.id])
        middle.push({
          op: "sheetMove",
          id: entry.id,
          after: previousLive(before.sheets, entry.id),
        });
  for (const key of new Set([...Object.keys(before.names), ...Object.keys(after.names)])) {
    const [was, is] = [before.names[key], after.names[key]];
    if (!same(was, is) && same(now.names[key], is))
      middle.push({ op: "name", name: was?.name ?? is!.name, f: was?.f ?? null });
  }
  for (const id of new Set([...Object.keys(before.charts), ...Object.keys(after.charts)]))
    middle.push(...chartUndo(id, before.charts[id], after.charts[id], now.charts[id]));
  for (const id of new Set([
    ...Object.keys(before.images ?? {}),
    ...Object.keys(after.images ?? {}),
  ]))
    middle.push(...imageUndo(id, before.images?.[id], after.images?.[id], now.images?.[id]));
  for (const thread of new Set([...Object.keys(before.anchors), ...Object.keys(after.anchors)])) {
    const [was, is] = [before.anchors[thread], after.anchors[thread]];
    if (!same(was, is) && same(now.anchors[thread], is))
      middle.push({ op: "anchor", thread, at: was ?? null });
  }
  if (!same(before.settings, after.settings) && same(now.settings, after.settings))
    middle.push({ op: "settings", ...before.settings });
  return [...first, ...middle, ...last];
}

/**
 * The operations undoing several steps, last first, each judged against what
 * undoing the later ones leaves. Others' edits between the steps then stay,
 * as they would not if the steps were undone as one.
 */
export function invertSteps(
  steps: readonly { readonly before: SheetDoc; readonly after: SheetDoc }[],
  now: SheetDoc,
): SheetOp[] {
  const ops: SheetOp[] = [];
  let current = now;
  for (const { before, after } of steps.toReversed()) {
    const inverse = invertChange(before, after, current);
    ops.push(...inverse);
    current = applyChange(current, { clientId: "undo", seq: 0, ops: inverse }, 0).doc;
  }
  return ops;
}
