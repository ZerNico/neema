import { parseCell } from "@chat/sheet/a1";
import type { Scalar } from "@chat/sheet/engine/values";
import { styleKey, type CellStyle } from "@chat/sheet/style";
import type { AxisProps, Box, Cell, ConditionalFormat, GridSheet } from "./grid-model.ts";

/** A cell by row and column number, as the test sheets key them. */
export const at = (row: number, col: number) => ({ r: `r${row}`, c: `c${col}` });

/**
 * A sheet for a test, its cells by A1 address: a value, or a value and its
 * style. Rows and columns are keyed `r1`… and `c1`….
 */
export function testSheet(
  cells: Record<string, Scalar | { value?: Scalar; style?: CellStyle }> = {},
  shape: {
    rows?: number;
    cols?: number;
    rowProps?: Record<string, AxisProps>;
    colProps?: Record<string, AxisProps>;
    merges?: Box[];
    freeze?: GridSheet["freeze"];
    conditional?: ConditionalFormat[];
  } = {},
) {
  const values = new Map<string, Scalar>();
  const drawn: Record<string, Record<string, Cell>> = {};
  for (const [ref, entry] of Object.entries(cells)) {
    const { row, column } = parseCell(ref)!;
    const { r, c } = at(row, column);
    const { value, style } =
      entry !== null && typeof entry === "object" && !("code" in entry)
        ? entry
        : { value: entry, style: undefined };
    if (value !== undefined && value !== null) values.set(`${r}|${c}`, value);
    const s = style ? styleKey(style) : undefined;
    (drawn[r] ??= {})[c] = s ? { s } : {};
  }
  const sheet: GridSheet = {
    name: "Sheet1",
    rows: Array.from({ length: shape.rows ?? 1000 }, (_, index) => `r${index + 1}`),
    cols: Array.from({ length: shape.cols ?? 26 }, (_, index) => `c${index + 1}`),
    cells: drawn,
    rowProps: shape.rowProps ?? {},
    colProps: shape.colProps ?? {},
    merges: shape.merges ?? [],
    freeze: shape.freeze ?? { row: null, col: null },
    ...(shape.conditional ? { conditional: shape.conditional } : {}),
  };
  return { sheet, value: (r: string, c: string): Scalar => values.get(`${r}|${c}`) ?? null };
}
