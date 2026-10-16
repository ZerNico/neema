import { strFromU8, unzipSync, type Unzipped } from "fflate";
import { getColumnDimension, getRowDimension, type Worksheet } from "@office-kit/xlsx/worksheet";
import { SpreadsheetError } from "../errors.ts";
import { SPREADSHEET_LIMITS } from "../limits.ts";
import { sheetParts } from "./dynamic-arrays.ts";
import { EMU_PER_PIXEL } from "./file-anchors.ts";
import { OFFICE_THEME_XML } from "./office-theme.ts";

/**
 * A sheet's charts as stored, for a preview to draw: each chart's own XML with
 * the values it plots, the workbook's theme (its colours and fonts), and the
 * size the chart occupies, in points. Read from the file rather than the
 * model, so a chart made in Excel keeps everything Excel wrote.
 */
export interface SheetChart {
  readonly chart: string;
  readonly theme: string;
  readonly width: number;
  readonly height: number;
  /** The cell its top-left corner sits in, 1-based, and how far into it, in pixels. */
  readonly place: {
    readonly row: number;
    readonly col: number;
    readonly x: number;
    readonly y: number;
  };
}

/** Charts one sheet preview draws, as many as a sheet may be given; more are counted, not drawn. */
const PREVIEW_CHARTS = SPREADSHEET_LIMITS.chartsPerSheet;
const CHART_BYTES = 2 * 1024 * 1024;
/** Office's own themes are about 8 KB; a larger one is drawn under the default. */
const THEME_BYTES = 512 * 1024;
const EMU_PER_POINT = 12_700;

/** A drawing element by name, whatever prefix its namespace has: writers differ, and some use none. */
const DRAWING = "(?:[\\w.-]+:)?";
/** An element's text by name: `<from>…</from>` under any prefix. */
const inside = (xml: string, name: string) =>
  new RegExp(`<${DRAWING}${name}>([\\s\\S]*?)</${DRAWING}${name}>`).exec(xml)?.[1];

const attribute = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

/** A relationship part's targets by id, resolved against the part that owns it. */
function relations(files: Unzipped, part: string) {
  const slash = part.lastIndexOf("/");
  const directory = part.slice(0, slash);
  const xml = files[`${directory}/_rels/${part.slice(slash + 1)}.rels`];
  const targets = new Map<string, { target: string; type: string }>();
  if (!xml) return targets;
  for (const [tag] of strFromU8(xml).matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attribute(tag, "Id");
    const target = attribute(tag, "Target");
    if (!id || !target || attribute(tag, "TargetMode") === "External") continue;
    const segments = target.startsWith("/") ? [] : directory.split("/");
    for (const segment of target.replace(/^\//, "").split("/"))
      if (segment === "..") segments.pop();
      else if (segment !== ".") segments.push(segment);
    targets.set(id, { target: segments.join("/"), type: attribute(tag, "Type") ?? "" });
  }
  return targets;
}

/**
 * Excel's column width to points. A stored width already includes the cell
 * padding, so 9.140625 is 64 pixels, the default column, at the Calibri 11
 * digit of 7 pixels.
 */
const columnPoints = (sheet: Worksheet, column: number) => {
  const characters = getColumnDimension(sheet, column)?.width;
  return (characters === undefined ? 64 : Math.trunc(characters * 7 + 0.5)) * 0.75;
};
const rowPoints = (sheet: Worksheet, row: number) => getRowDimension(sheet, row)?.height ?? 15;

/** A two-cell anchor's span in points, from its markers' cells and offsets. */
function spanned(sheet: Worksheet, anchor: string, axis: "col" | "row") {
  const marker = (name: "from" | "to") => {
    const inner = inside(anchor, name) ?? "";
    const read = (tag: string) => Number(inside(inner, tag) ?? 0);
    return { index: read(axis), offset: read(`${axis}Off`) / EMU_PER_POINT };
  };
  const from = marker("from");
  const to = marker("to");
  // Markers are zero-based; widths are by one-based column and row.
  const size = axis === "col" ? columnPoints : rowPoints;
  let points = to.offset - from.offset;
  for (let index = from.index; index < Math.min(to.index, from.index + 500); index++)
    points += size(sheet, index + 1);
  return points;
}

/** Where an anchor's top-left corner sits; null for one placed by absolute position. */
function placeOf(anchor: string): SheetChart["place"] | null {
  const from = inside(anchor, "from");
  if (!from) return null;
  const read = (tag: string) => Number(inside(from, tag) ?? 0);
  return {
    row: Math.max(0, read("row")) + 1,
    col: Math.max(0, read("col")) + 1,
    x: Math.max(0, Math.round(read("colOff") / EMU_PER_PIXEL)),
    y: Math.max(0, Math.round(read("rowOff") / EMU_PER_PIXEL)),
  };
}

function sizeOf(sheet: Worksheet, anchor: string) {
  const ext = new RegExp(`<${DRAWING}ext\\b[^>]*>`).exec(anchor)?.[0];
  if (ext && !new RegExp(`^<${DRAWING}twoCellAnchor`).test(anchor))
    return {
      width: Number(attribute(ext, "cx") ?? 0) / EMU_PER_POINT,
      height: Number(attribute(ext, "cy") ?? 0) / EMU_PER_POINT,
    };
  return { width: spanned(sheet, anchor, "col"), height: spanned(sheet, anchor, "row") };
}

/**
 * Every chart anchored on a sheet, in drawing order: its anchor element and,
 * for a classic chart, its part's bytes. Newer chart kinds (chartex) have none.
 */
export function chartAnchors(files: Unzipped, title: string) {
  const part = sheetParts(files).get(title);
  if (!part) return [];
  const drawing = [...relations(files, part).values()].find((each) =>
    each.type.endsWith("/drawing"),
  )?.target;
  const drawingXml = drawing ? files[drawing] : undefined;
  if (!drawing || !drawingXml) return [];
  const targets = relations(files, drawing);
  const anchors = strFromU8(drawingXml).matchAll(
    /<((?:[\w.-]+:)?)(twoCellAnchor|oneCellAnchor|absoluteAnchor)\b[\s\S]*?<\/\1\2>/g,
  );
  return [...anchors].flatMap(([anchor]) => {
    const reference = /<c:chart\b[^>]*>/.exec(anchor)?.[0];
    if (!reference) return /<cx:chart\b/.test(anchor) ? [{ anchor, part: null }] : [];
    const id = /\sr:id="([^"]*)"/.exec(reference)?.[1];
    const target = id ? targets.get(id)?.target : undefined;
    return [{ anchor, part: (target && files[target]) || null }];
  });
}

/** The charts of `sheet`, in drawing order, and how many more it holds than are drawn. */
export function sheetCharts(bytes: Uint8Array, sheet: Worksheet) {
  const files = unzipSync(bytes);
  const workbookRels = relations(files, "xl/workbook.xml");
  const themePart = [...workbookRels.values()].find((each) => each.type.endsWith("/theme"))?.target;
  // A workbook without a theme reads as Excel's default one.
  const themeBytes = themePart ? files[themePart] : undefined;
  const theme =
    themeBytes && themeBytes.length <= THEME_BYTES ? strFromU8(themeBytes) : OFFICE_THEME_XML;
  const charts: SheetChart[] = [];
  let others = 0;
  for (const { anchor, part } of chartAnchors(files, sheet.title)) {
    const size = sizeOf(sheet, anchor);
    const place = placeOf(anchor);
    if (
      !part ||
      !place ||
      part.length > CHART_BYTES ||
      charts.length >= PREVIEW_CHARTS ||
      !(Number.isFinite(size.width) && Number.isFinite(size.height)) ||
      !(size.width > 0 && size.height > 0)
    ) {
      // A newer chart kind, one placed by absolute position, or one past what a preview draws.
      others += 1;
      continue;
    }
    charts.push({ chart: strFromU8(part), theme, ...size, place });
  }
  return { charts, others };
}

/** One chart of a sheet for a preview, by its position among the drawn ones. */
export function sheetChart(bytes: Uint8Array, sheet: Worksheet, index: number) {
  return (
    sheetCharts(bytes, sheet).charts[index] ??
    (() => {
      throw new SpreadsheetError("not_found", `Chart ${index + 1} does not exist on this sheet.`);
    })()
  );
}
