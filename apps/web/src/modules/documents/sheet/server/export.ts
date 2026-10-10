import { columnLetters } from "@chat/sheet/a1";
import { quoteSheet, renderFormula } from "@chat/sheet/model/formula";
import { liveSheets, positions, type SheetDoc } from "@chat/sheet/model";
import type { LiveSheetExport } from "~/modules/spreadsheets/server/adapter.ts";

const address = (row: number, column: number) => `${columnLetters(column)}${row}`;

/**
 * A live sheet as the workbook built from it: positions instead of IDs,
 * formulas as text, and text that would read as a formula escaped as
 * setCells escapes it.
 */
export function liveSheetExport(doc: SheetDoc): LiveSheetExport {
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
      const frozenRow = sheet.freeze.row ? (rows.at(sheet.freeze.row) ?? 0) : 0;
      const frozenCol = sheet.freeze.col ? (cols.at(sheet.freeze.col) ?? 0) : 0;
      return {
        name: sheet.name,
        cells,
        merges,
        widths: sized(sheet.colProps, cols.at),
        heights: sized(sheet.rowProps, rows.at),
        ...(frozenRow || frozenCol ? { freeze: address(frozenRow + 1, frozenCol + 1) } : {}),
      };
    }),
    names: Object.values(doc.names).map((name) => ({
      name: name.name,
      value: renderFormula(name.f, { doc, sheet: ids[0]! }),
    })),
    charts: Object.values(doc.charts).flatMap((chart) => {
      const host = doc.sheet[chart.sheet];
      if (!host || !ids.includes(chart.sheet)) return [];
      /** A range by IDs as Excel text on its sheet; null once its rows or columns are gone. */
      const range = (on: string, box: { r1: string; r2: string; c1: string; c2: string }) => {
        const data = doc.sheet[on];
        if (!data || !ids.includes(on)) return null;
        const rows = positions(data.rows);
        const cols = positions(data.cols);
        const corners = [rows.at(box.r1), cols.at(box.c1), rows.at(box.r2), cols.at(box.c2)];
        if (corners.some((each) => each === undefined)) return null;
        const [top, left, bottom, right] = corners as [number, number, number, number];
        return `${quoteSheet(data.name)}!${address(top, left)}:${address(bottom, right)}`;
      };
      const at = [positions(host.rows).at(chart.at.r), positions(host.cols).at(chart.at.c)];
      const series = chart.series.flatMap((each) => {
        const values = range(each.sheet ?? chart.sheet, each.values);
        return values ? [{ values, ...(each.name ? { name: each.name } : {}) }] : [];
      });
      const first = chart.series[0];
      const categories = first?.categories
        ? range(first.sheet ?? chart.sheet, first.categories)
        : null;
      if (!series.length || at[0] === undefined || at[1] === undefined) return [];
      return [
        {
          sheet: host.name,
          type: chart.kind,
          at: address(at[0], at[1]),
          ...(chart.title ? { title: chart.title } : {}),
          ...(categories ? { categories } : {}),
          series,
          width: chart.size.width,
          height: chart.size.height,
        },
      ];
    }),
  };
}
