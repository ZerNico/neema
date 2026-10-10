import { patchChart } from "./chart.ts";
import { LIVE_LIMITS } from "./limits.ts";
import { copyFormula, type FormulaAt } from "./formula.ts";
import {
  positions,
  type AxisEntry,
  type AxisProps,
  type Box,
  type Cell,
  type Formula,
  type IdRef,
  type RefCorner,
  type Sheet,
  type SheetDoc,
} from "./model.ts";
import type { Area, SheetChange, SheetOp, StylePatch } from "./ops.ts";

/**
 * Applies a change to a document. Total and deterministic: given the same
 * document, change and revision it gives the same result on every replica,
 * and it never throws. A part naming something that no longer exists is
 * dropped and reported in plain words; the rest still applies.
 */
export function applyChange(
  doc: SheetDoc,
  change: SheetChange,
  revision: number,
): { doc: SheetDoc; dropped: string[] } {
  const dropped: string[] = [];
  let next = doc;
  for (const op of change.ops) next = applyOp(next, op, revision, dropped);
  return { doc: next, dropped };
}

/** A style key: the style's properties in a fixed order, so every replica writes the same key. */
export const styleKey = (style: Readonly<Record<string, string | number | boolean>>) => {
  const keys = Object.keys(style).toSorted();
  return keys.length
    ? JSON.stringify(Object.fromEntries(keys.map((key) => [key, style[key]])))
    : undefined;
};
const styleOf = (key: string | undefined): Record<string, string | number | boolean> =>
  key ? (JSON.parse(key) as Record<string, string | number | boolean>) : {};
const patched = (key: string | undefined, patch: StylePatch) => {
  const style = styleOf(key);
  for (const [name, value] of Object.entries(patch)) {
    if (value === null) delete style[name];
    else style[name] = value;
  }
  return styleKey(style);
};

/** Whether an ID is a live entry, through the order list's cached index. */
const alive = (entries: readonly AxisEntry[], id: string) =>
  positions(entries).at(id) !== undefined;

/** Live IDs from `a` to `b` in order, either way round; empty when either is not alive. */
function between(entries: readonly AxisEntry[], a: string | null, b: string | null): string[] {
  const index = positions(entries);
  if (a === null || b === null) return a === null && b === null ? [...index.ids] : [];
  const [x, y] = [index.at(a), index.at(b)];
  if (x === undefined || y === undefined) return [];
  return index.ids.slice(Math.min(x, y) - 1, Math.max(x, y));
}

const withSheet = (doc: SheetDoc, id: string, sheet: Sheet): SheetDoc => ({
  ...doc,
  sheet: { ...doc.sheet, [id]: sheet },
});

/** Writes cells into a sheet, copying only the rows touched. */
function writeCells(sheet: Sheet, writes: Iterable<[string, string, Cell | null]>): Sheet {
  const cells: Record<string, Readonly<Record<string, Cell>>> = { ...sheet.cells };
  const copied = new Set<string>();
  for (const [r, c, cell] of writes) {
    if (!copied.has(r)) {
      cells[r] = { ...cells[r] };
      copied.add(r);
    }
    const row = cells[r] as Record<string, Cell>;
    if (cell === null) delete row[c];
    else row[c] = cell;
  }
  return { ...sheet, cells };
}

const cellAt = (sheet: Sheet, r: string, c: string): Cell | undefined => sheet.cells[r]?.[c];

/** Content dropped, write version and format kept: a cleared cell still says when it was cleared. */
const cleared = (cell: Cell | undefined, revision: number): Cell => ({
  w: revision,
  ...(cell?.s ? { s: cell.s } : {}),
  ...(cell?.wf !== undefined ? { wf: cell.wf } : {}),
});

function areaCells(sheet: Sheet, area: Area) {
  const rows = between(sheet.rows, area.r1, area.r2);
  const cols = between(sheet.cols, area.c1, area.c2);
  return { rows, cols };
}

/** Every formula in the document, rewritten by `map`, which returns the same object to keep one. */
function mapFormulas(doc: SheetDoc, map: (formula: Formula, sheet: string) => Formula): SheetDoc {
  let next = doc;
  for (const [id, sheet] of Object.entries(doc.sheet)) {
    const writes: [string, string, Cell][] = [];
    for (const [r, row] of Object.entries(sheet.cells))
      for (const [c, cell] of Object.entries(row)) {
        if (!cell.f) continue;
        const f = map(cell.f, id);
        if (f !== cell.f) writes.push([r, c, { ...cell, f }]);
      }
    if (writes.length) next = withSheet(next, id, writeCells(next.sheet[id]!, writes));
  }
  const names = Object.fromEntries(
    Object.entries(next.names).map(([key, name]) => [
      key,
      { ...name, f: map(name.f, liveFirst(next)) },
    ]),
  );
  return { ...next, names };
}
const liveFirst = (doc: SheetDoc) => doc.sheets.find((entry) => !entry.dead)?.id ?? "";

function applyOp(doc: SheetDoc, op: SheetOp, revision: number, dropped: string[]): SheetDoc {
  const sheetOf = (id: string) => (alive(doc.sheets, id) ? doc.sheet[id] : undefined);
  switch (op.op) {
    case "set": {
      const sheet = sheetOf(op.sh);
      if (!sheet) return drop(doc, dropped, `cells on a sheet that is gone`);
      const writes: [string, string, Cell][] = [];
      for (const write of op.cells) {
        if (!alive(sheet.rows, write.r) || !alive(sheet.cols, write.c)) {
          dropped.push("a cell whose row or column was deleted");
          continue;
        }
        const old = cellAt(sheet, write.r, write.c);
        const content =
          write.f !== undefined
            ? { f: write.f, ...(write.array ? { array: write.array } : {}) }
            : write.v !== undefined && write.v !== null
              ? { v: write.v }
              : {};
        writes.push([
          write.r,
          write.c,
          {
            ...content,
            w: revision,
            ...(old?.s ? { s: old.s } : {}),
            ...(old?.wf !== undefined ? { wf: old.wf } : {}),
          },
        ]);
      }
      return withSheet(doc, op.sh, writeCells(sheet, writes));
    }
    case "clear":
    case "format": {
      const sheet = sheetOf(op.sh);
      if (!sheet) return drop(doc, dropped, `a range on a sheet that is gone`);
      const { rows, cols } = areaCells(sheet, op.area);
      if (!rows.length || !cols.length)
        return drop(doc, dropped, "a range whose rows or columns were deleted");
      // A format makes a cell of every place it covers: past what a sheet holds, refused before any is made.
      if (op.op === "format" && rows.length * cols.length > LIVE_LIMITS.cells)
        return drop(doc, dropped, "a format over more cells than a sheet holds");
      const writes: [string, string, Cell | null][] = [];
      const touched = op.op === "format" || op.what !== "contents";
      // Clearing touches only cells that exist, however large the range.
      const covered = op.op === "clear" ? new Set(cols) : null;
      const places: Iterable<readonly [string, string]> = covered
        ? rows.flatMap((r) =>
            Object.keys(sheet.cells[r] ?? {})
              .filter((c) => covered.has(c))
              .map((c) => [r, c] as const),
          )
        : rows.flatMap((r) => cols.map((c) => [r, c] as const));
      for (const [r, c] of places) {
        const old = cellAt(sheet, r, c);
        if (op.op === "format") {
          writes.push([
            r,
            c,
            compact<Cell>({ ...(old ?? { w: 0 }), s: patched(old?.s, op.patch), wf: revision }),
          ]);
          continue;
        }
        if (!old) continue;
        if (op.what === "formats")
          writes.push([r, c, compact<Cell>({ ...old, s: undefined, wf: revision })]);
        else if (op.what === "contents") writes.push([r, c, cleared(old, revision)]);
        else writes.push([r, c, { w: revision, wf: revision }]);
      }
      let next = writeCells(sheet, writes);
      // A whole row or column carries its format for the cells that come later.
      if (touched && (op.area.r1 === null || op.area.c1 === null)) {
        const axis = op.area.r1 === null ? "colProps" : "rowProps";
        const ids = op.area.r1 === null ? cols : rows;
        const props = { ...next[axis] } as Record<string, AxisProps>;
        for (const id of ids) {
          const s = op.op === "format" ? patched(props[id]?.s, op.patch) : undefined;
          props[id] = compact<AxisProps>({ ...props[id], s });
        }
        next = { ...next, [axis]: props };
      }
      return withSheet(doc, op.sh, next);
    }
    case "resize":
    case "hide": {
      const sheet = sheetOf(op.sh);
      if (!sheet) return drop(doc, dropped, "a size on a sheet that is gone");
      const key = op.axis === "rows" ? "rowProps" : "colProps";
      const props = { ...sheet[key] } as Record<string, AxisProps>;
      for (const id of op.ids)
        props[id] = compact<AxisProps>(
          op.op === "resize"
            ? { ...props[id], size: op.size ?? undefined }
            : { ...props[id], hidden: op.hidden ? true : undefined },
        );
      return withSheet(doc, op.sh, { ...sheet, [key]: props });
    }
    case "insert": {
      const sheet = sheetOf(op.sh);
      if (!sheet) return drop(doc, dropped, "rows or columns on a sheet that is gone");
      const key = op.axis === "rows" ? "rows" : "cols";
      const entries = sheet[key];
      const known = new Set(entries.map((entry) => entry.id));
      // Each new ID once, and none a row or column already has.
      const ids = [...new Set(op.ids)].filter((id) => !known.has(id));
      if (ids.length < op.ids.length) dropped.push("rows or columns that already exist");
      const at = op.after === null ? 0 : (positions(entries).raw(op.after) ?? -1) + 1;
      if (at === 0 && op.after !== null)
        return drop(doc, dropped, "rows or columns next to one that is gone");
      const added = ids.map((id) => ({ id }));
      return withSheet(doc, op.sh, {
        ...sheet,
        [key]: [...entries.slice(0, at), ...added, ...entries.slice(at)],
      });
    }
    case "delete":
    case "revive": {
      const sheet = sheetOf(op.sh);
      if (!sheet) return drop(doc, dropped, "rows or columns on a sheet that is gone");
      const key = op.axis === "rows" ? "rows" : "cols";
      const ids = new Set(op.ids);
      const entries = sheet[key].map((entry) =>
        ids.has(entry.id)
          ? op.op === "delete"
            ? { id: entry.id, dead: true as const }
            : { id: entry.id }
          : entry,
      );
      const next = withSheet(doc, op.sh, { ...sheet, [key]: entries });
      return op.op === "delete"
        ? shrinkBoxes(shrinkRanges(next, op.sh, op.axis, ids), op.sh, op.axis, ids)
        : next;
    }
    case "merge":
    case "unmerge": {
      const sheet = sheetOf(op.sh);
      if (!sheet) return drop(doc, dropped, "a merge on a sheet that is gone");
      const box = op.box;
      const rows = between(sheet.rows, box.r1, box.r2);
      const cols = between(sheet.cols, box.c1, box.c2);
      if (!rows.length || !cols.length)
        return drop(doc, dropped, "a merge whose rows or columns were deleted");
      const overlaps = (other: Box) => {
        const otherRows = new Set(between(sheet.rows, other.r1, other.r2));
        const otherCols = new Set(between(sheet.cols, other.c1, other.c2));
        return rows.some((r) => otherRows.has(r)) && cols.some((c) => otherCols.has(c));
      };
      // The merge itself when it is there, as undo names it; else every one the box touches.
      if (op.op === "unmerge") {
        const same = (other: Box) =>
          other.r1 === box.r1 && other.r2 === box.r2 && other.c1 === box.c1 && other.c2 === box.c2;
        const exact = sheet.merges.some(same);
        return withSheet(doc, op.sh, {
          ...sheet,
          merges: sheet.merges.filter((other) => (exact ? !same(other) : !overlaps(other))),
        });
      }
      // A merge over one already there loses, in server order, as Excel refuses overlapping merges.
      if (sheet.merges.some(overlaps)) return drop(doc, dropped, "a merge over another merge");
      return withSheet(doc, op.sh, { ...sheet, merges: [...sheet.merges, box] });
    }
    case "freeze": {
      const sheet = sheetOf(op.sh);
      if (!sheet) return drop(doc, dropped, "frozen panes on a sheet that is gone");
      return withSheet(doc, op.sh, { ...sheet, freeze: { row: op.row, col: op.col } });
    }
    case "outline": {
      const sheet = sheetOf(op.sh);
      if (!sheet) return drop(doc, dropped, "groups on a sheet that is gone");
      const key = op.axis === "rows" ? "rows" : "cols";
      const { [key]: _old, ...others } = sheet.outline ?? {};
      const outline = op.list.length ? { ...others, [key]: op.list } : others;
      const { outline: _was, ...rest } = sheet;
      return withSheet(doc, op.sh, Object.keys(outline).length ? { ...rest, outline } : rest);
    }
    case "validations": {
      const sheet = sheetOf(op.sh);
      if (!sheet) return drop(doc, dropped, "validation on a sheet that is gone");
      const { validations: _old, ...rest } = sheet;
      return withSheet(doc, op.sh, op.list.length ? { ...rest, validations: op.list } : rest);
    }
    case "conditional": {
      const sheet = sheetOf(op.sh);
      if (!sheet) return drop(doc, dropped, "conditional formats on a sheet that is gone");
      const { conditional: _old, ...rest } = sheet;
      return withSheet(doc, op.sh, op.list.length ? { ...rest, conditional: op.list } : rest);
    }
    case "filter": {
      const sheet = sheetOf(op.sh);
      if (!sheet) return drop(doc, dropped, "a filter on a sheet that is gone");
      const { filter: _old, ...rest } = sheet;
      return withSheet(doc, op.sh, op.filter ? { ...rest, filter: op.filter } : rest);
    }
    case "sheetAdd": {
      if (doc.sheet[op.id]) return drop(doc, dropped, "a sheet that already exists");
      const at = op.after === null ? 0 : (positions(doc.sheets).raw(op.after) ?? -1) + 1;
      if (at === 0 && op.after !== null)
        return drop(doc, dropped, "a sheet next to one that is gone");
      const sheet: Sheet = {
        name: uniqueName(doc, op.name),
        rows: op.rows.map((id) => ({ id })),
        cols: op.cols.map((id) => ({ id })),
        cells: {},
        rowProps: {},
        colProps: {},
        merges: [],
        freeze: { row: null, col: null },
      };
      return {
        ...doc,
        sheets: [...doc.sheets.slice(0, at), { id: op.id }, ...doc.sheets.slice(at)],
        sheet: { ...doc.sheet, [op.id]: sheet },
      };
    }
    case "sheetRename": {
      const sheet = sheetOf(op.id);
      if (!sheet) return drop(doc, dropped, "a sheet that is gone");
      return withSheet(doc, op.id, { ...sheet, name: uniqueName(doc, op.name, op.id) });
    }
    case "sheetColor": {
      const sheet = sheetOf(op.id);
      if (!sheet) return drop(doc, dropped, "a sheet that is gone");
      const { color: _, ...rest } = sheet;
      return withSheet(doc, op.id, op.color ? { ...rest, color: op.color.toUpperCase() } : rest);
    }
    case "sheetMove": {
      if (!sheetOf(op.id)) return drop(doc, dropped, "a sheet that is gone");
      const rest = doc.sheets.filter((entry) => entry.id !== op.id);
      const moving = doc.sheets.find((entry) => entry.id === op.id)!;
      const at = op.after === null ? 0 : (positions(rest).raw(op.after) ?? -1) + 1;
      if (at === 0 && op.after !== null)
        return drop(doc, dropped, "a sheet moved next to one that is gone");
      return { ...doc, sheets: [...rest.slice(0, at), moving, ...rest.slice(at)] };
    }
    case "sheetDelete":
    case "sheetRevive": {
      if (!doc.sheet[op.id]) return drop(doc, dropped, "a sheet nobody has");
      const live = doc.sheets.filter((entry) => !entry.dead);
      if (op.op === "sheetDelete" && live.length === 1 && live[0]!.id === op.id)
        return drop(doc, dropped, "the last sheet");
      return {
        ...doc,
        sheets: doc.sheets.map((entry) =>
          entry.id === op.id
            ? op.op === "sheetDelete"
              ? { id: entry.id, dead: true as const }
              : { id: entry.id }
            : entry,
        ),
      };
    }
    case "name": {
      const key = op.name.toLowerCase();
      const names = { ...doc.names };
      if (op.f === null) delete names[key];
      else names[key] = { name: op.name, f: op.f };
      return { ...doc, names };
    }
    case "settings":
      return {
        ...doc,
        settings: {
          locale: op.locale ?? doc.settings.locale,
          timeZone: op.timeZone ?? doc.settings.timeZone,
        },
      };
    case "chartPut":
      if (!sheetOf(op.chart.sheet)) return drop(doc, dropped, "a chart on a sheet that is gone");
      return { ...doc, charts: { ...doc.charts, [op.id]: op.chart } };
    case "chartPatch": {
      const chart = doc.charts[op.id];
      if (!chart) return drop(doc, dropped, "a chart that is gone");
      return { ...doc, charts: { ...doc.charts, [op.id]: patchChart(chart, op.patch) } };
    }
    case "imagePut":
      if (!sheetOf(op.image.sheet)) return drop(doc, dropped, "a picture on a sheet that is gone");
      return { ...doc, images: { ...doc.images, [op.id]: op.image } };
    case "imageDelete": {
      if (!doc.images?.[op.id]) return doc;
      const { [op.id]: _gone, ...images } = doc.images;
      if (Object.keys(images).length) return { ...doc, images };
      const { images: _none, ...rest } = doc;
      return rest;
    }
    case "chartDelete": {
      const charts = { ...doc.charts };
      delete charts[op.id];
      return { ...doc, charts };
    }
    case "anchor": {
      const anchors = { ...doc.anchors };
      if (op.at === null) delete anchors[op.thread];
      else anchors[op.thread] = op.at;
      return { ...doc, anchors };
    }
    case "move":
      return move(doc, op, revision, dropped);
    case "sort":
      return sort(doc, op, revision, dropped);
  }
}

const drop = (doc: SheetDoc, dropped: string[], what: string) => {
  dropped.push(what);
  return doc;
};

/** The object without its undefined fields: a removed format or size leaves no key behind. */
const compact = <T>(value: object): T =>
  Object.fromEntries(Object.entries(value).filter(([, each]) => each !== undefined)) as T;

/** A name no other live sheet has, case-insensitively: "Data", then "Data (2)". */
function uniqueName(doc: SheetDoc, wanted: string, self?: string) {
  const taken = new Set(
    doc.sheets
      .filter((entry) => !entry.dead && entry.id !== self)
      .map((entry) => doc.sheet[entry.id]!.name.toLowerCase()),
  );
  const base = wanted.trim() || "Sheet";
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} (${n})`.toLowerCase())) return `${base} (${n})`;
}

/**
 * Moves range endpoints off rows or columns just deleted, to the nearest live
 * one inward, as Excel rewrites them. Done here rather than when read, since
 * a row later inserted beside a dead endpoint must not join the range. A
 * range with nothing left keeps its dead endpoints and shows #REF!.
 */
function shrinkRanges(
  doc: SheetDoc,
  sheetId: string,
  axis: "rows" | "columns",
  deleted: ReadonlySet<string>,
): SheetDoc {
  const entries = axis === "rows" ? doc.sheet[sheetId]!.rows : doc.sheet[sheetId]!.cols;
  const index = positions(entries);
  const field = axis === "rows" ? "row" : "col";
  return mapFormulas(doc, (formula, sheet) => {
    let changed = false;
    const parts = formula.parts.map((part) => {
      if (typeof part === "string" || part.k !== "ref" || !part.to) return part;
      if ((part.sheet ?? sheet) !== sheetId) return part;
      const [a, b] = [part.from[field], part.to[field]];
      if (a === null || b === null || (!deleted.has(a) && !deleted.has(b))) return part;
      const [rawA, rawB] = [index.raw(a), index.raw(b)];
      if (rawA === undefined || rawB === undefined) return part;
      const forward: 1 | -1 = rawA <= rawB ? 1 : -1;
      const start = deleted.has(a) ? index.nearest(a, forward) : index.at(a);
      const end = deleted.has(b) ? index.nearest(b, forward === 1 ? -1 : 1) : index.at(b);
      if (start === undefined || end === undefined || (forward === 1 ? start > end : start < end))
        return part;
      changed = true;
      return {
        ...part,
        from: { ...part.from, [field]: index.ids[start - 1]! },
        to: { ...part.to, [field]: index.ids[end - 1]! },
      } satisfies IdRef;
    });
    return changed ? { parts } : formula;
  });
}

/**
 * Moves the endpoints of every range a sheet keeps by IDs off rows or columns
 * just deleted, as `shrinkRanges` does for formulas: a filter, validation,
 * conditional formats, list sources and charts' series. One with nothing left
 * keeps its dead endpoints, and draws or checks nothing.
 */
function shrinkBoxes(
  doc: SheetDoc,
  sheetId: string,
  axis: "rows" | "columns",
  deleted: ReadonlySet<string>,
): SheetDoc {
  const sheet = doc.sheet[sheetId]!;
  const index = positions(axis === "rows" ? sheet.rows : sheet.cols);
  const [first, second] = axis === "rows" ? (["r1", "r2"] as const) : (["c1", "c2"] as const);
  const shrink = <B extends Box>(box: B): B => {
    const [a, b] = [box[first], box[second]];
    if (!deleted.has(a) && !deleted.has(b)) return box;
    const start = deleted.has(a) ? index.nearest(a, 1) : index.at(a);
    const end = deleted.has(b) ? index.nearest(b, -1) : index.at(b);
    if (start === undefined || end === undefined || start > end) return box;
    return { ...box, [first]: index.ids[start - 1]!, [second]: index.ids[end - 1]! };
  };
  const onSheet = <T extends { readonly sh: string; readonly box: Box }>(source: T): T =>
    source.sh === sheetId ? { ...source, box: shrink(source.box) } : source;
  const filter = sheet.filter && {
    box: shrink(sheet.filter.box),
    // A deleted column takes its rule with it.
    rules:
      axis === "columns"
        ? Object.fromEntries(Object.entries(sheet.filter.rules).filter(([c]) => !deleted.has(c)))
        : sheet.filter.rules,
  };
  const key = axis === "rows" ? "rows" : "cols";
  const groups = sheet.outline?.[key];
  const next: Sheet = {
    ...sheet,
    // A group's deleted ends move inward too, as a range of one row or column.
    ...(groups
      ? {
          outline: {
            ...sheet.outline,
            [key]: groups.map((group) => {
              const span = shrink({ r1: group.from, r2: group.to, c1: group.from, c2: group.to });
              return axis === "rows"
                ? { ...group, from: span.r1, to: span.r2 }
                : { ...group, from: span.c1, to: span.c2 };
            }),
          },
        }
      : {}),
    ...(filter ? { filter } : {}),
    ...(sheet.conditional
      ? { conditional: sheet.conditional.map((each) => ({ ...each, box: shrink(each.box) })) }
      : {}),
    ...(sheet.validations
      ? {
          validations: sheet.validations.map((each) => ({
            ...each,
            box: shrink(each.box),
            ...(each.rule.kind === "list" && each.rule.source
              ? { rule: { ...each.rule, source: onSheet(each.rule.source) } }
              : {}),
          })),
        }
      : {}),
  };
  // Lists on other sheets may read their choices from this one.
  let out = withSheet(doc, sheetId, next);
  for (const id of Object.keys(out.sheet)) {
    if (id === sheetId) continue;
    const other = out.sheet[id]!;
    if (
      !other.validations?.some(
        (each) => each.rule.kind === "list" && each.rule.source?.sh === sheetId,
      )
    )
      continue;
    out = withSheet(out, id, {
      ...other,
      validations: other.validations.map((each) =>
        each.rule.kind === "list" && each.rule.source
          ? { ...each, rule: { ...each.rule, source: onSheet(each.rule.source) } }
          : each,
      ),
    });
  }
  const charts = Object.fromEntries(
    Object.entries(out.charts).map(([id, chart]) => {
      const reads = (on: string | undefined) => (on ?? chart.sheet) === sheetId;
      return [
        id,
        {
          ...chart,
          series: chart.series.map((each) =>
            reads(each.sheet)
              ? {
                  ...each,
                  values: shrink(each.values),
                  ...(each.categories ? { categories: shrink(each.categories) } : {}),
                  ...(each.sizes ? { sizes: shrink(each.sizes) } : {}),
                }
              : each,
          ),
          ...(chart.source && chart.source.sheet === sheetId
            ? { source: { ...chart.source, box: shrink(chart.source.box) } }
            : {}),
        },
      ];
    }),
  );
  return { ...out, charts };
}

/** Cut and paste: contents move, and every reference wholly inside the moved cells follows them. */
function move(
  doc: SheetDoc,
  op: Extract<SheetOp, { op: "move" }>,
  revision: number,
  dropped: string[],
): SheetDoc {
  const source = alive(doc.sheets, op.sh) ? doc.sheet[op.sh] : undefined;
  const targetId = op.to.sh ?? op.sh;
  const target = alive(doc.sheets, targetId) ? doc.sheet[targetId] : undefined;
  if (!source || !target) return drop(doc, dropped, "a move to or from a sheet that is gone");
  const rows = between(source.rows, op.box.r1, op.box.r2);
  const cols = between(source.cols, op.box.c1, op.box.c2);
  const targetRows = positions(target.rows);
  const targetCols = positions(target.cols);
  const [top, left] = [targetRows.at(op.to.r), targetCols.at(op.to.c)];
  if (!rows.length || !cols.length || top === undefined || left === undefined)
    return drop(doc, dropped, "a move whose cells were deleted");
  const toRows = targetRows.ids.slice(top - 1, top - 1 + rows.length);
  const toCols = targetCols.ids.slice(left - 1, left - 1 + cols.length);
  if (toRows.length < rows.length || toCols.length < cols.length)
    return drop(doc, dropped, "a move past the edge of the sheet");
  const rowMap = new Map(rows.map((id, index) => [id, toRows[index]!]));
  const colMap = new Map(cols.map((id, index) => [id, toCols[index]!]));
  const moved: [string, string, Cell][] = [];
  const emptied: [string, string, Cell][] = [];
  for (const r of rows)
    for (const c of cols) {
      const cell = cellAt(source, r, c);
      emptied.push([r, c, cleared(cell, revision)]);
      if (cell) moved.push([rowMap.get(r)!, colMap.get(c)!, { ...cell, w: revision }]);
    }
  let next = withSheet(doc, op.sh, writeCells(source, emptied));
  const landed = next.sheet[targetId]!;
  const overwritten: [string, string, Cell][] = [];
  for (const r of toRows)
    for (const c of toCols) overwritten.push([r, c, cleared(cellAt(landed, r, c), revision)]);
  next = withSheet(next, targetId, writeCells(writeCells(landed, overwritten), moved));
  // References wholly inside the cut cells follow them, wherever they are written.
  const inside = (corner: RefCorner) =>
    (corner.row === null || rowMap.has(corner.row)) &&
    (corner.col === null || colMap.has(corner.col));
  const follow = (corner: RefCorner): RefCorner => ({
    ...corner,
    row: corner.row === null ? null : rowMap.get(corner.row)!,
    col: corner.col === null ? null : colMap.get(corner.col)!,
  });
  return mapFormulas(next, (formula, sheet) => {
    let changed = false;
    const parts = formula.parts.map((part) => {
      if (typeof part === "string" || part.k !== "ref") return part;
      if ((part.sheet ?? sheet) !== op.sh || part.from.row === null || part.from.col === null)
        return part;
      if (!inside(part.from) || (part.to && !inside(part.to))) return part;
      changed = true;
      // Written on the target sheet, it names no sheet; anywhere else it names the target.
      const sheetRef =
        part.sheet === null && targetId === sheet ? null : targetId === sheet ? null : targetId;
      return {
        ...part,
        sheet: sheetRef,
        from: follow(part.from),
        to: part.to ? follow(part.to) : null,
      } satisfies IdRef;
    });
    return changed ? { parts } : formula;
  });
}

/** Contents move between rows by the given order; moved formulas shift as a copy would. */
function sort(
  doc: SheetDoc,
  op: Extract<SheetOp, { op: "sort" }>,
  revision: number,
  dropped: string[],
): SheetDoc {
  const sheet = alive(doc.sheets, op.sh) ? doc.sheet[op.sh] : undefined;
  if (!sheet) return drop(doc, dropped, "a sort on a sheet that is gone");
  const rowIndex = positions(sheet.rows);
  // The same rows each once in the new order, checked in linear time.
  const given = new Set(op.rows);
  const sameSet =
    op.rows.length === op.order.length &&
    given.size === op.rows.length &&
    new Set(op.order).size === op.order.length &&
    op.order.every((id) => given.has(id));
  if (!sameSet || op.rows.some((id) => rowIndex.at(id) === undefined))
    return drop(doc, dropped, "a sort over rows that changed");
  const cols = between(sheet.cols, op.c1, op.c2);
  if (!cols.length) return drop(doc, dropped, "a sort whose columns were deleted");
  const at: FormulaAt = { doc, sheet: op.sh };
  const writes: [string, string, Cell][] = [];
  op.rows.forEach((to, index) => {
    const from = op.order[index]!;
    if (from === to) return;
    const shift = { rows: rowIndex.at(to)! - rowIndex.at(from)!, cols: 0 };
    for (const c of cols) {
      const cell = cellAt(sheet, from, c);
      if (!cell) {
        writes.push([to, c, cleared(cellAt(sheet, to, c), revision)]);
        continue;
      }
      const copied = cell.f ? copyFormula(cell.f, shift, at) : null;
      const f = copied && "formula" in copied ? copied.formula : cell.f;
      writes.push([to, c, { ...cell, ...(f ? { f } : {}), w: revision }]);
    }
  });
  return withSheet(doc, op.sh, writeCells(sheet, writes));
}
