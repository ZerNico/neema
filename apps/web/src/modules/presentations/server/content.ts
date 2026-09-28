import {
  clearTableCellFill,
  emu,
  getPresentationTheme,
  getTableCell,
  getTableDimensions,
  setParagraphBullet,
  setParagraphLevel,
  setShapeAlignment,
  setShapeFill,
  setShapeNoFill,
  setShapeNoStroke,
  setShapeParagraphs,
  setShapeStroke,
  setShapeText,
  setShapeTextFormat,
  setTableCellAlignment,
  setTableCellAnchor,
  setTableCellBorders,
  setTableCellFill,
  setTableCellTextFormat,
  setTableColumnWidth,
  setTableRowHeight,
  setTableStyleFlags,
  type ChartSpec,
  type Color,
  type getSlideShapes,
  type ParagraphAlignment,
  type TextFormat,
} from "@office-kit/pptx";
import type { PresentationColor } from "../operations.ts";
import type { Deck } from "./package.ts";
import { fail } from "./package-xml.ts";

/** How operation fields become Office Kit text, fills, charts and tables. */
type Shape = ReturnType<typeof getSlideShapes>[number];
type Hex = `#${string}`;

export const toEmu = (value: number) => emu(Math.round(value * 12700));
export const emuBox = (value: { x: number; y: number; width: number; height: number }) => ({
  x: toEmu(value.x),
  y: toEmu(value.y),
  w: toEmu(value.width),
  h: toEmu(value.height),
});

const themeSlots: Record<string, string> = {
  dark1: "dk1",
  light1: "lt1",
  dark2: "dk2",
  light2: "lt2",
};
/** A theme name becomes a theme slot, so the colour follows the deck's palette in PowerPoint too. */
export const colorOf = (value: PresentationColor): Color =>
  value.startsWith("#") ? (value as Hex) : ((themeSlots[value] ?? value) as Color);
/** Charts and raw XML need a concrete colour, taken from the deck's own theme. */
export const hexOf = (deck: Deck, value: PresentationColor): Hex => {
  if (value.startsWith("#")) return value as Hex;
  const hex = (getPresentationTheme(deck) as Record<string, string> | null)?.[value];
  return hex && /^#[0-9a-f]{6}$/i.test(hex) ? (hex.toUpperCase() as Hex) : "#000000";
};

type Format = {
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: PresentationColor;
  font?: string;
};
type Written = Format & {
  text?: string;
  paragraphs?: readonly (Format & {
    text?: string;
    runs?: readonly (Format & { text: string })[];
    level?: number;
    bullet?: string;
    align?: string;
  })[];
  align?: string;
};
export const textFormat = (source: Format): TextFormat | undefined => {
  const format = {
    ...(source.fontSize !== undefined ? { size: source.fontSize } : {}),
    ...(source.bold !== undefined ? { bold: source.bold } : {}),
    ...(source.italic !== undefined ? { italic: source.italic } : {}),
    ...(source.underline !== undefined ? { underline: source.underline } : {}),
    ...(source.color ? { color: colorOf(source.color) } : {}),
    ...(source.font ? { font: source.font } : {}),
  };
  return Object.keys(format).length ? format : undefined;
};
export const alignment = (value: string) => value as ParagraphAlignment;

export function writeText(shape: Shape, source: Written) {
  if (source.text !== undefined) setShapeText(shape, source.text);
  else if (source.paragraphs) {
    setShapeParagraphs(
      shape,
      source.paragraphs.map((paragraph) => {
        const runs = paragraph.runs ?? [{ text: paragraph.text ?? "" }];
        return {
          ...(paragraph.align ? { align: alignment(paragraph.align) } : {}),
          runs: runs.map((run) => {
            const format = textFormat({ ...paragraph, ...run });
            return { text: run.text, ...(format ? { format } : {}) };
          }),
        };
      }),
    );
    source.paragraphs.forEach((paragraph, index) => {
      if (paragraph.level !== undefined) setParagraphLevel(shape, index, paragraph.level);
      if (paragraph.bullet)
        setParagraphBullet(shape, index, paragraph.bullet as "bullet" | "number" | "none");
    });
  }
  const format = textFormat(source);
  if (format) setShapeTextFormat(shape, format);
  if (source.align) setShapeAlignment(shape, alignment(source.align));
}

export function paint(
  shape: Shape,
  style: {
    fill?: PresentationColor | "none";
    line?: PresentationColor | "none";
    lineWidth?: number;
  },
) {
  if (style.fill === "none") setShapeNoFill(shape);
  else if (style.fill) setShapeFill(shape, colorOf(style.fill));
  if (style.line === "none") setShapeNoStroke(shape);
  else if (style.line || style.lineWidth !== undefined)
    setShapeStroke(shape, {
      ...(style.line ? { color: colorOf(style.line) } : {}),
      ...(style.lineWidth !== undefined ? { widthEmu: Math.round(style.lineWidth * 12700) } : {}),
    });
}

export type ChartContent = {
  chartType?: string;
  title?: string;
  categories: string[];
  series: { name: string; values: number[]; color?: PresentationColor }[];
  stacking?: string;
  legend?: string;
  dataLabels?: boolean;
  numberFormat?: string;
  valueAxisTitle?: string;
  categoryAxisTitle?: string;
  valueAxisMin?: number;
  valueAxisMax?: number;
  gridlines?: boolean;
  gapWidth?: number;
  textColor?: PresentationColor;
  textFont?: string;
  textSize?: number;
};
export const chartKinds = new Set(["column", "bar", "line", "area", "pie", "doughnut"]);
export const isRound = (kind: string) => kind === "pie" || kind === "doughnut";
const legendPositions = { right: "r", top: "t", bottom: "b", left: "l" } as const;

export function chartSpec(deck: Deck, content: ChartContent, kind: string): ChartSpec {
  const round = isRound(kind);
  if (round && content.series.length !== 1)
    fail("invalid_operation", `${kind} charts take exactly one series.`);
  const text =
    content.textColor || content.textFont || content.textSize !== undefined
      ? {
          ...(content.textColor ? { color: hexOf(deck, content.textColor) } : {}),
          ...(content.textFont ? { font: content.textFont } : {}),
          ...(content.textSize !== undefined ? { sizePt: content.textSize } : {}),
        }
      : null;
  const common = {
    categories: content.categories,
    ...(content.title ? { title: content.title } : {}),
    ...(text
      ? {
          titleStyle: {
            ...text,
            ...(content.textSize !== undefined ? { sizePt: content.textSize + 6 } : {}),
          },
        }
      : {}),
    ...(content.legend || text
      ? {
          legend: {
            position:
              content.legend === "none"
                ? null
                : legendPositions[(content.legend ?? "right") as keyof typeof legendPositions],
            ...(text ? { textStyle: text } : {}),
          },
        }
      : {}),
    ...(content.dataLabels
      ? {
          dataLabels: {
            showValue: !round,
            showPercent: round,
            showCategory: false,
            showSeriesName: false,
            ...(content.numberFormat && !round ? { numberFormat: content.numberFormat } : {}),
            ...(text ? { textStyle: text } : {}),
          },
        }
      : {}),
  };
  const series = content.series.map((item) => ({
    name: item.name,
    values: item.values,
    ...(item.color ? { color: hexOf(deck, item.color) } : {}),
  }));
  if (round) return { kind, ...common, series: [series[0]!] } as ChartSpec;
  const grouping =
    content.stacking === "stacked"
      ? "stacked"
      : content.stacking === "percent"
        ? "percentStacked"
        : kind === "column" || kind === "bar"
          ? "clustered"
          : "standard";
  const scaling = {
    ...(content.valueAxisMin !== undefined ? { min: content.valueAxisMin } : {}),
    ...(content.valueAxisMax !== undefined ? { max: content.valueAxisMax } : {}),
    ...(content.numberFormat ? { numberFormat: content.numberFormat } : {}),
  };
  return {
    kind,
    ...common,
    series,
    grouping,
    ...(Object.keys(scaling).length ? { valueAxis: scaling } : {}),
    ...(content.valueAxisTitle ? { valueAxisTitle: content.valueAxisTitle } : {}),
    ...(content.categoryAxisTitle ? { categoryAxisTitle: content.categoryAxisTitle } : {}),
    ...(content.gridlines !== undefined ? { valueAxisMajorGridlines: content.gridlines } : {}),
    ...(content.gapWidth !== undefined && (kind === "column" || kind === "bar")
      ? { gapWidthPct: content.gapWidth }
      : {}),
    ...(text ? { valueAxisLabelStyle: text, categoryAxisLabelStyle: text } : {}),
  } as ChartSpec;
}

type TableStyle = {
  headerFill?: PresentationColor;
  headerColor?: PresentationColor;
  headerBold?: boolean;
  bodyFill?: PresentationColor | "none";
  bandFill?: PresentationColor;
  textColor?: PresentationColor;
  font?: string;
  fontSize?: number;
  borderColor?: PresentationColor | "none";
  borderWidth?: number;
  columnWidths?: number[];
  rowHeight?: number;
  columnAlign?: string[];
  verticalAlign?: string;
};
/**
 * Styles every cell explicitly. The preview ignores PowerPoint's table style
 * IDs, so explicit fills and borders are what make both look the same.
 */
export function styleTable(deck: Deck, table: Shape, style: TableStyle, header: boolean) {
  const { rows, cols } = getTableDimensions(table);
  if (style.columnWidths && style.columnWidths.length !== cols)
    fail("invalid_operation", `columnWidths needs ${cols} entries, one per column.`);
  if (style.columnAlign && style.columnAlign.length !== cols)
    fail("invalid_operation", `columnAlign needs ${cols} entries, one per column.`);
  style.columnWidths?.forEach((width, column) => setTableColumnWidth(table, column, toEmu(width)));
  if (style.rowHeight !== undefined)
    for (let row = 0; row < rows; row++) setTableRowHeight(table, row, toEmu(style.rowHeight));
  if (style.bodyFill === "none") setTableStyleFlags(table, { bandRow: false });
  const border =
    style.borderColor === "none"
      ? null
      : style.borderColor || style.borderWidth !== undefined
        ? {
            ...(style.borderColor ? { color: hexOf(deck, style.borderColor) } : {}),
            widthEmu: Math.round((style.borderWidth ?? 1) * 12700),
          }
        : null;
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < cols; column++) {
      const cell = getTableCell(table, row, column);
      const isHeader = header && row === 0;
      const band = !isHeader && (row - (header ? 1 : 0)) % 2 === 1;
      const fill = isHeader
        ? style.headerFill
        : band && style.bandFill
          ? style.bandFill
          : style.bodyFill;
      if (fill === "none") clearTableCellFill(cell);
      else if (fill) setTableCellFill(cell, colorOf(fill));
      const format = textFormat({
        ...(style.font ? { font: style.font } : {}),
        ...(style.fontSize !== undefined ? { fontSize: style.fontSize } : {}),
        ...(isHeader
          ? {
              ...(style.headerColor ? { color: style.headerColor } : {}),
              ...(style.headerBold !== undefined ? { bold: style.headerBold } : {}),
            }
          : style.textColor
            ? { color: style.textColor }
            : {}),
      });
      if (format) setTableCellTextFormat(cell, format);
      // "No borders" draws each edge in the cell's own fill: a missing line
      // previews as grey, and a matching one disappears in both.
      const edge =
        style.borderColor === "none"
          ? { color: hexOf(deck, fill && fill !== "none" ? fill : "light1"), widthEmu: 9525 }
          : border;
      if (edge) setTableCellBorders(cell, { left: edge, right: edge, top: edge, bottom: edge });
      const align = style.columnAlign?.[column];
      if (align) setTableCellAlignment(cell, alignment(align));
      if (style.verticalAlign)
        setTableCellAnchor(cell, style.verticalAlign as "top" | "center" | "bottom");
    }
}
