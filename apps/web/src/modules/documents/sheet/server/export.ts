import { columnLetters } from "@chat/sheet/a1";
import { quoteSheet, renderFormula } from "@chat/sheet/model/formula";
import { liveSheets, positions, type SheetDoc } from "@chat/sheet/model";
import type { FileFilter, LiveSheetExport } from "~/modules/spreadsheets/server/adapter.ts";
import type { SheetValues } from "@chat/sheet/model/calc";
import { filterSpan, filteredRows, shownText, type SheetFilter } from "@chat/sheet/model/filter";
import { fileChartOf } from "./chart-files.ts";

const address = (row: number, column: number) => `${columnLetters(column)}${row}`;

/**
 * A live sheet as the workbook built from it: positions instead of IDs,
 * formulas as text, and text that would read as a formula escaped as
 * setCells escapes it.
 */
/**
 * A sheet's filter as Excel files keep one: a list of values per column. A
 * condition, which the file cannot hold here, goes as the values that pass it.
 */
function fileFilterOf(
  doc: SheetDoc,
  sheet: string,
  filter: SheetFilter,
  values: SheetValues | undefined,
): FileFilter | null {
  const span = filterSpan(doc, sheet, filter);
  if (!span) return null;
  const rows = positions(doc.sheet[sheet]!.rows);
  const cols = positions(doc.sheet[sheet]!.cols);
  const [top, left] = [rows.at(span.header)!, cols.at(span.columns[0]!)!];
  const [bottom, right] = [top + span.body.length, left + span.columns.length - 1];
  const columns = Object.entries(filter.rules).flatMap(([column, rule]) => {
    const index = span.columns.indexOf(column);
    if (index === -1) return [];
    let kept = rule.values ? [...rule.values] : null;
    if (rule.condition && values) {
      // Each value of the column's rows that this column's rule lets through.
      const only = { ...filter, rules: { [column]: rule } };
      const view = {
        ...doc,
        sheet: { ...doc.sheet, [sheet]: { ...doc.sheet[sheet]!, filter: only } },
      };
      const hidden = filteredRows(view, values, sheet);
      kept = [
        ...new Set(
          span.body
            .filter((r) => !hidden.has(r))
            .map((r) => shownText(doc, values, sheet, r, column)),
        ),
      ];
    }
    if (!kept) return [];
    return [{ col: index, values: kept.filter((each) => each !== ""), blank: kept.includes("") }];
  });
  return { ref: `${address(top, left)}:${address(bottom, right)}`, columns };
}

export function liveSheetExport(doc: SheetDoc, values?: SheetValues): LiveSheetExport {
  const ids = liveSheets(doc);
  return {
    sheets: ids.map((id) => {
      const sheet = doc.sheet[id]!;
      const rows = positions(sheet.rows);
      const cols = positions(sheet.cols);
      const cells: Array<LiveSheetExport["sheets"][number]["cells"][number]> = [];
      for (const [r, row] of Object.entries(sheet.cells)) {
        const rowAt = rows.at(r);
        if (rowAt === undefined) continue;
        for (const [c, cell] of Object.entries(row)) {
          const column = cols.at(c);
          if (column === undefined) continue;
          const input = cell.f
            ? `=${renderFormula(cell.f, { doc, sheet: id })}`
            : typeof cell.v === "string" && /^[='"]/.test(cell.v)
              ? `'${cell.v}`
              : (cell.v ?? undefined);
          const style = cell.s
            ? (JSON.parse(cell.s) as Record<string, string | number | boolean>)
            : undefined;
          if (input === undefined && !style) continue;
          cells.push({
            row: rowAt,
            column,
            ...(input === undefined ? {} : { input }),
            ...(style ? { style } : {}),
          });
        }
      }
      const merges = sheet.merges.flatMap((merge) => {
        const [top, bottom, left, right] = [
          rows.at(merge.r1),
          rows.at(merge.r2),
          cols.at(merge.c1),
          cols.at(merge.c2),
        ];
        return top && bottom && left && right
          ? [`${address(top, left)}:${address(bottom, right)}`]
          : [];
      });
      const sized = (
        props: typeof sheet.rowProps,
        at: (id: string) => number | undefined,
      ): Array<[number, number]> =>
        Object.entries(props).flatMap(([entry, each]) => {
          const index = at(entry);
          return index !== undefined && each.size !== undefined ? [[index, each.size]] : [];
        });
      const hiddenOf = (props: typeof sheet.rowProps, at: (id: string) => number | undefined) =>
        Object.entries(props).flatMap(([entry, each]) => {
          const index = at(entry);
          return index !== undefined && each.hidden ? [index] : [];
        });
      // Excel does not filter on opening: the rows a filter hides go in hidden, as it saves them.
      const filtered = values ? [...filteredRows(doc, values, id)] : [];
      const hiddenRows = [
        ...new Set([
          ...hiddenOf(sheet.rowProps, rows.at),
          ...filtered.flatMap((r) => rows.at(r) ?? []),
        ]),
      ].toSorted((a, b) => a - b);
      const hiddenCols = hiddenOf(sheet.colProps, cols.at);
      const filter = sheet.filter ? fileFilterOf(doc, id, sheet.filter, values) : null;
      /** A range by IDs as A1, or null once its cells are gone. */
      const refOf = (on: string, box: { r1: string; r2: string; c1: string; c2: string }) => {
        const data = doc.sheet[on];
        if (!data) return null;
        const [r, c] = [positions(data.rows), positions(data.cols)];
        const corners = [r.at(box.r1), c.at(box.c1), r.at(box.r2), c.at(box.c2)];
        if (corners.some((each) => each === undefined)) return null;
        const [top, left, bottom, right] = corners as [number, number, number, number];
        return `${address(top, left)}:${address(bottom, right)}`;
      };
      const validations = (sheet.validations ?? []).flatMap((validation) => {
        const ref = refOf(id, validation.box);
        if (!ref) return [];
        const { rule } = validation;
        const source =
          rule.kind === "list" && rule.source ? refOf(rule.source.sh, rule.source.box) : null;
        if (rule.kind === "list" && rule.source && !source) return [];
        return [
          {
            ref,
            rule:
              rule.kind === "list"
                ? source
                  ? {
                      kind: "list" as const,
                      // Absolute, as Excel writes a list's cells, named when on another sheet.
                      source: `${rule.source!.sh === id ? "" : `${quoteSheet(doc.sheet[rule.source!.sh]!.name)}!`}${source.replace(/([A-Z]+)(\d+)/g, "$$$1$$$2")}`,
                    }
                  : { kind: "list" as const, values: rule.values ?? [] }
                : rule,
            onError: validation.onError,
            allowBlank: validation.allowBlank,
            ...(validation.message ? { message: validation.message } : {}),
          },
        ];
      });
      const conditional = (sheet.conditional ?? []).flatMap((format) => {
        const corners = [
          rows.at(format.box.r1),
          cols.at(format.box.c1),
          rows.at(format.box.r2),
          cols.at(format.box.c2),
        ];
        if (corners.some((each) => each === undefined)) return [];
        const [top, left, bottom, right] = corners as [number, number, number, number];
        return [{ ref: `${address(top, left)}:${address(bottom, right)}`, rule: format.rule }];
      });
      const frozenRow = sheet.freeze.row ? (rows.at(sheet.freeze.row) ?? 0) : 0;
      const frozenCol = sheet.freeze.col ? (cols.at(sheet.freeze.col) ?? 0) : 0;
      return {
        name: sheet.name,
        cells,
        merges,
        widths: sized(sheet.colProps, cols.at),
        heights: sized(sheet.rowProps, rows.at),
        ...(frozenRow || frozenCol ? { freeze: address(frozenRow + 1, frozenCol + 1) } : {}),
        ...(hiddenRows.length ? { hiddenRows } : {}),
        ...(hiddenCols.length ? { hiddenCols } : {}),
        ...(filter ? { filter } : {}),
        ...(conditional.length ? { conditional } : {}),
        ...(validations.length ? { validations } : {}),
      };
    }),
    names: Object.values(doc.names).map((name) => ({
      name: name.name,
      value: renderFormula(name.f, { doc, sheet: ids[0]! }),
    })),
    charts: Object.values(doc.charts).flatMap((chart) => {
      const file = fileChartOf(doc, chart);
      return file ? [file] : [];
    }),
  };
}
