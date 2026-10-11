import type { ReactNode } from "react";
import { columnLetters } from "@chat/sheet/a1";
import type { SheetLocale } from "@chat/sheet/locales";
import type { Sheet } from "@chat/sheet/model";
import type { SheetValues } from "@chat/sheet/model/calc";
import type { CellLook } from "@chat/sheet/model/conditional";
import { cellStyle } from "@chat/sheet/model/style";
import { cellCss, cellDisplay } from "./display.ts";
import { key, type mergeIndex } from "./grid-navigation.ts";
import { textWidth, type AxisLayout } from "./layout.ts";

/** What drawing a pane's cells reads from the grid. */
export interface PaneDrawing {
  readonly gridId: string;
  readonly sheet: string;
  readonly cells: Sheet["cells"];
  readonly values: SheetValues;
  readonly locale: SheetLocale;
  readonly looks: ReadonlyMap<string, CellLook>;
  readonly rows: AxisLayout;
  readonly cols: AxisLayout;
  readonly rowIndex: ReadonlyMap<string, number>;
  readonly colIndex: ReadonlyMap<string, number>;
  readonly merges: ReturnType<typeof mergeIndex>;
  /** The active cell by index, or null. */
  readonly head: { readonly row: number; readonly col: number } | null;
  readonly zoom: number;
  readonly filterButtons: {
    readonly row: string;
    readonly cols: readonly string[];
    readonly active: ReadonlySet<string>;
  } | null;
  readonly onFilterButton: ((col: string, button: HTMLElement) => void) | undefined;
}

/**
 * The cells of one pane: rows and columns in the given ranges. Only the
 * scrolling pane's cells are named for assistive tech and keep the active
 * cell mounted; the frozen panes repeat theirs over it.
 */
export function drawPane(
  {
    gridId,
    sheet,
    cells: sheetCells,
    values,
    locale,
    looks,
    rows,
    cols,
    rowIndex,
    colIndex,
    merges,
    head,
    zoom,
    filterButtons,
    onFilterButton,
  }: PaneDrawing,
  rowRange: { first: number; last: number },
  colRange: { first: number; last: number },
  main: boolean,
) {
  const cells: ReactNode[] = [];
  const drawn = new Set<string>();
  const draw = (row: number, col: number, overflowTo: number) => {
    const span = merges.spans.get(key(row, col));
    const r = rows.ids[row]!;
    const c = cols.ids[col]!;
    const cell = sheetCells[r]?.[c];
    const look = looks.get(`${r}|${c}`);
    // Conditional formats show over the cell's own style, as Excel draws them.
    const own = cellStyle(cell?.s);
    const style = look
      ? {
          ...own,
          ...(look.fill ? { fill: look.fill } : {}),
          ...(look.fontColor ? { fontColor: look.fontColor } : {}),
          ...(look.bold ? { bold: true } : {}),
          ...(look.italic ? { italic: true } : {}),
        }
      : own;
    const value = values.value(sheet, r, c);
    const shown = cellDisplay(value, style, locale);
    const bottom = span ? span.bottom : row;
    const right = span ? span.right : col;
    const active = main && head?.row === row && head.col === col;
    const spills = !span && overflowTo > col;
    drawn.add(key(row, col));
    // The empty cells text runs over keep their bottom line, without the lines between them.
    if (spills)
      cells.push(
        <div
          key={`${key(row, col)}-spill`}
          aria-hidden
          className="border-border bg-background absolute z-[1] border-b"
          style={{
            top: rows.starts[row],
            left: cols.starts[col + 1],
            height: rows.size(row),
            width: cols.starts[overflowTo + 1]! - cols.starts[col + 1]!,
          }}
        />,
      );
    cells.push(
      <div
        key={key(row, col)}
        id={active ? `${gridId}-active` : undefined}
        role={main ? "gridcell" : undefined}
        aria-rowindex={main ? row + 1 : undefined}
        aria-colindex={main ? col + 1 : undefined}
        aria-selected={active || undefined}
        className={`border-border text-foreground absolute flex border-b px-1 text-sm leading-tight whitespace-pre ${spills ? "overflow-visible" : "overflow-hidden border-r"}`}
        style={{
          top: rows.starts[row],
          left: cols.starts[col],
          height: rows.starts[bottom + 1]! - rows.starts[row]!,
          width: cols.starts[right + 1]! - cols.starts[col]!,
          alignItems:
            style.vertical === "top"
              ? "flex-start"
              : style.vertical === "center"
                ? "center"
                : "flex-end",
          justifyContent:
            shown.align === "right"
              ? "flex-end"
              : shown.align === "center"
                ? "center"
                : "flex-start",
          textAlign: shown.align,
          // Its fill and borders stay in its own column; only its text runs on, above the spill.
          zIndex: spills ? 2 : span ? 1 : undefined,
          ...cellCss(style),
          fontSize: (style.fontSize ? (style.fontSize * 4) / 3 : 14) * zoom,
          ...(shown.color ? { color: shown.color } : {}),
        }}
      >
        {look?.bar ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0.5 left-0.5 rounded-xs opacity-60"
            style={{
              width: `calc(${look.bar.fraction * 100}% - 4px)`,
              // The rule's own colour, which is the sheet's data.
              background: `linear-gradient(to right, ${look.bar.color}, color-mix(in oklab, ${look.bar.color} 30%, transparent))`,
            }}
          />
        ) : null}
        <span
          className={
            own.link
              ? `relative underline underline-offset-2${style.fontColor || shown.color ? "" : " text-primary"}`
              : "relative"
          }
        >
          {shown.text}
        </span>
      </div>,
    );
  };
  for (let row = rowRange.first; row <= rowRange.last; row++)
    for (let col = colRange.first; col <= colRange.last; col++) {
      if (drawn.has(key(row, col))) continue;
      if (merges.covered.has(key(row, col))) continue;
      // Text runs on over empty cells to its right, as in Excel, unless it wraps.
      let overflowTo = col;
      const r = rows.ids[row]!;
      const value = values.value(sheet, r, cols.ids[col]!);
      const style = cellStyle(sheetCells[r]?.[cols.ids[col]!]?.s);
      if (typeof value === "string" && !style.wrap && (style.horizontal ?? "left") === "left") {
        // Only as far as the text needs: text that fits keeps its cell's borders.
        const needed =
          (textWidth(value, style.fontSize ? (style.fontSize * 4) / 3 : 14, style.bold) + 8) * zoom;
        while (
          cols.starts[overflowTo + 1]! - cols.starts[col]! < needed &&
          overflowTo + 1 <= colRange.last &&
          !merges.covered.has(key(row, overflowTo + 1)) &&
          !merges.spans.has(key(row, overflowTo + 1)) &&
          values.value(sheet, r, cols.ids[overflowTo + 1]!) === null
        )
          overflowTo++;
        for (let skip = col + 1; skip <= overflowTo; skip++) drawn.add(key(row, skip));
      }
      draw(row, col, overflowTo);
    }
  // Merges starting above or left of the pane still show where they reach into it.
  for (const span of merges.spans.values())
    if (
      !drawn.has(key(span.top, span.left)) &&
      span.bottom >= rowRange.first &&
      span.top <= rowRange.last &&
      span.right >= colRange.first &&
      span.left <= colRange.last
    )
      draw(span.top, span.left, span.left);
  // The active cell stays in the tree when scrolled away, so assistive tech still finds it.
  if (main && head && !drawn.has(key(head.row, head.col)) && rows.ids.length && cols.ids.length)
    draw(head.row, head.col, head.col);
  // A filter's buttons, at the right of its header cells, as Excel draws them.
  if (filterButtons) {
    const row = rowIndex.get(filterButtons.row);
    if (row !== undefined && row >= rowRange.first && row <= rowRange.last)
      for (const c of filterButtons.cols) {
        const col = colIndex.get(c);
        if (col === undefined || col < colRange.first || col > colRange.last || !cols.size(col))
          continue;
        const active = filterButtons.active.has(c);
        cells.push(
          <button
            key={`filter-${c}`}
            type="button"
            aria-label={`Filter ${columnLetters(col + 1)}`}
            aria-pressed={active}
            tabIndex={-1}
            className={`border-border absolute z-[3] flex size-4 items-center justify-center rounded-sm border ${active ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground"}`}
            style={{
              top: rows.starts[row]! + (rows.size(row) - 16) / 2,
              left: cols.starts[col + 1]! - 18,
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => onFilterButton?.(c, event.currentTarget)}
          >
            <svg aria-hidden viewBox="0 0 10 10" className="size-2.5" fill="currentColor">
              {active ? <path d="M1 2h8L6 5.5V9L4 8V5.5z" /> : <path d="M2 3.5h6L5 7z" />}
            </svg>
          </button>,
        );
      }
  }
  return cells;
}
