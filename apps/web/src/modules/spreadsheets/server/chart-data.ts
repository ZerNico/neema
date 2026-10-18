import { strFromU8, strToU8 } from "fflate";
import type { PackageParts } from "../../office/server/package.ts";
import { isFormulaValue, type Cell } from "@office-kit/xlsx/cell";
import { listChartsOnSheet } from "@office-kit/xlsx/drawing";
import { getCellDisplayText } from "@office-kit/xlsx/styles";
import { getSheet, iterWorksheets, type Workbook } from "@office-kit/xlsx/workbook";
import { getCell } from "@office-kit/xlsx/worksheet";
import { boxArea, parseRange } from "@chat/sheet/a1";
import { chartAnchors } from "./chart-parts.ts";

/**
 * A chart stores a copy of the values it plots beside the cells it reads, as
 * Excel saves it. Excel redraws from the cells on open; every other reader
 * (previews, viewers, importers, our own preview) draws the copy, so a chart
 * without one shows no data. Each save refreshes the copies from the values
 * the cells hold now.
 */
const NUMERIC = new Set(["val", "yVal", "bubbleSize"]);
const CATEGORY = new Set(["cat", "xVal"]);
/** Points one reference keeps a copy of; a longer range is left to Excel. */
const POINTS = 4_000;

const numberOf = (cell: Cell | undefined) => {
  if (!cell) return null;
  const value = cell.value;
  if (typeof value === "number") return value;
  if (isFormulaValue(value) && typeof value.cachedValue === "number") return value.cachedValue;
  return null;
};

/** The cells a chart reference names, row by row, or null when it names none here. */
function cellsOf(workbook: Workbook, ref: string) {
  const bang = ref.lastIndexOf("!");
  if (bang === -1) return null;
  const title = ref
    .slice(0, bang)
    .replace(/^'(.*)'$/, "$1")
    .replaceAll("''", "'");
  const sheet = getSheet(workbook, title);
  const box = parseRange(ref.slice(bang + 1).replaceAll("$", ""));
  if (!sheet || !box || boxArea(box) > POINTS) return null;
  const cells: Array<Cell | undefined> = [];
  for (let row = box.top; row <= box.bottom; row++)
    for (let column = box.left; column <= box.right; column++)
      cells.push(getCell(sheet, row, column));
  return cells;
}

function refresh(workbook: Workbook, kind: string, data: Record<string, unknown>) {
  const cells = typeof data.ref === "string" ? cellsOf(workbook, data.ref) : null;
  if (!cells) return;
  const numbers = cells.map(numberOf);
  if (numbers.every((value) => value !== null)) {
    data.cache = numbers;
    if (CATEGORY.has(kind)) data.cacheKind = "num";
    return;
  }
  if (CATEGORY.has(kind)) {
    // Labels as the sheet shows them; a blank cell is an empty label.
    data.cache = cells.map((cell) => (cell ? getCellDisplayText(workbook, cell) : ""));
    data.cacheKind = "str";
    return;
  }
  // A series with blanks or text has no numeric copy the file format can hold
  // point by point here; Excel draws it from the cells.
  delete data.cache;
}

/** Refreshes every chart's stored values from the workbook's current cells. */
export function refreshChartData(workbook: Workbook) {
  const walk = (node: unknown, key: string): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, key);
      return;
    }
    const record = node as Record<string, unknown>;
    if (NUMERIC.has(key) || CATEGORY.has(key)) refresh(workbook, key, record);
    for (const [child, value] of Object.entries(record)) walk(value, child);
  };
  for (const sheet of iterWorksheets(workbook))
    for (const chart of listChartsOnSheet(sheet)) walk(chart, "");
}

const escapeXml = (text: string) =>
  text.replace(
    /[<>&"]/g,
    (character) => `&${{ "<": "lt", ">": "gt", "&": "amp", '"': "quot" }[character]};`,
  );
const unescapeXml = (text: string) =>
  text.replace(
    /&(lt|gt|amp|quot|apos);/g,
    (_, entity: string) => ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" })[entity]!,
  );

/**
 * Series names as Excel stores them. The chart library writes a literal name
 * as a reference with an empty formula, where the format's own form is the
 * name alone, and drops the text a name read from a cell keeps beside its
 * reference, which every reader but Excel shows.
 */
export function finishSeriesNames(workbook: Workbook, files: PackageParts): boolean {
  let changed = false;
  for (const name of Object.keys(files)) {
    if (!/^xl\/charts\/chart\d+\.xml$/.test(name)) continue;
    const xml = strFromU8(files[name]!);
    const fixed = xml
      .replace(
        /<c:tx><c:strRef><c:f><\/c:f><c:strCache><c:ptCount val="1"\/><c:pt idx="0">(<c:v>[^<]*<\/c:v>)<\/c:pt><\/c:strCache><\/c:strRef><\/c:tx>/g,
        "<c:tx>$1</c:tx>",
      )
      .replace(/<c:tx><c:strRef><c:f>([^<]+)<\/c:f><\/c:strRef><\/c:tx>/g, (whole, ref: string) => {
        const cells = cellsOf(workbook, unescapeXml(ref));
        const cell = cells?.length === 1 ? cells[0] : undefined;
        if (!cell) return whole;
        const text = escapeXml(getCellDisplayText(workbook, cell));
        return `<c:tx><c:strRef><c:f>${ref}</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${text}</c:v></c:pt></c:strCache></c:strRef></c:tx>`;
      });
    if (fixed === xml) continue;
    files[name] = strToU8(fixed);
    changed = true;
  }
  return changed;
}

/**
 * The chart library reads no series names, so a chart it loads would lose
 * every legend name on save. They are read from the file's own chart parts,
 * matched to the loaded charts in drawing order and by series index.
 */
export function restoreSeriesNames(workbook: Workbook, files: PackageParts) {
  for (const sheet of iterWorksheets(workbook)) {
    const loaded = listChartsOnSheet(sheet);
    if (!loaded.length) continue;
    const stored = chartAnchors(files, sheet.title);
    // Only a one-to-one match is trusted; anything else keeps the library's reading.
    if (stored.length !== loaded.length) continue;
    stored.forEach(({ part }, index) => {
      const item = loaded[index]!;
      if (!part || item.content.kind !== "chart" || !item.content.chart.space) return;
      const names = new Map<
        number,
        { kind: "ref"; ref: string } | { kind: "literal"; value: string }
      >();
      for (const [, idx, tx] of strFromU8(part).matchAll(
        /<c:ser>\s*<c:idx val="(\d+)"\/>\s*<c:order val="\d+"\/>\s*<c:tx>([\s\S]*?)<\/c:tx>/g,
      )) {
        const ref = /<c:f>([^<]+)<\/c:f>/.exec(tx!)?.[1];
        const value = /<c:v>([^<]*)<\/c:v>/.exec(tx!)?.[1];
        if (ref) names.set(Number(idx), { kind: "ref", ref: unescapeXml(ref) });
        else if (value !== undefined)
          names.set(Number(idx), { kind: "literal", value: unescapeXml(value) });
      }
      const walk = (node: unknown): void => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) return node.forEach(walk);
        const record = node as Record<string, unknown>;
        const name = typeof record.idx === "number" ? names.get(record.idx) : undefined;
        if (name && !record.tx && ("val" in record || "yVal" in record)) record.tx = name;
        for (const child of Object.values(record)) walk(child);
      };
      walk(item.content.chart.space);
    });
  }
}
