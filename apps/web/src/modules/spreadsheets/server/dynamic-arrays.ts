import { strFromU8, strToU8, unzipSync, zipSync, type Unzipped } from "fflate";
import { isFormulaValue, type Cell } from "@office-kit/xlsx/cell";
import { iterWorksheets, type Workbook } from "@office-kit/xlsx/workbook";
import { getCell, type Worksheet } from "@office-kit/xlsx/worksheet";
import { columnIndex, columnLetters } from "../operations.ts";

/**
 * Excel 365 marks a formula that may spill with cell metadata (`cm`) naming
 * the XLDAPR type in `xl/metadata.xml`; without the mark the same formula is
 * a legacy one, and Excel reads its ranges by implicit intersection. The file
 * library drops `cm` on read and never writes it, so this module reads the
 * marks from the raw parts and writes them back after saving.
 */
const registry = new WeakMap<Workbook, Map<Worksheet, Set<Cell>>>();

export function dynamicCells(workbook: Workbook) {
  let found = registry.get(workbook);
  if (!found) {
    found = new Map();
    registry.set(workbook, found);
  }
  return found;
}
export const isDynamic = (workbook: Workbook, sheet: Worksheet, cell: Cell) =>
  registry.get(workbook)?.get(sheet)?.has(cell) ?? false;
export function markDynamic(workbook: Workbook, sheet: Worksheet, cell: Cell, dynamic = true) {
  const sheets = dynamicCells(workbook);
  const cells = sheets.get(sheet) ?? new Set<Cell>();
  if (dynamic) cells.add(cell);
  else cells.delete(cell);
  sheets.set(sheet, cells);
}

const METADATA = "xl/metadata.xml";
const METADATA_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml";
const METADATA_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/sheetMetadata";
/** Excel's own metadata part for dynamic arrays: one type, one cell mark (cm="1"). */
const DYNAMIC_METADATA =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<metadata xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:xda="http://schemas.microsoft.com/office/spreadsheetml/2017/dynamicarray">' +
  '<metadataTypes count="1"><metadataType name="XLDAPR" minSupportedVersion="120000" copy="1" pasteAll="1" pasteValues="1" merge="1" splitFirst="1" rowColShift="1" clearFormats="1" clearComments="1" assign="1" coerce="1" cellMeta="1"/></metadataTypes>' +
  '<futureMetadata name="XLDAPR" count="1"><bk><extLst><ext uri="{bdbb8cdc-fa1e-496e-a857-3c3f30c029c3}"><xda:dynamicArrayProperties fDynamic="1" fCollapsed="0"/></ext></extLst></bk></futureMetadata>' +
  '<cellMetadata count="1"><bk><rc t="1" v="0"/></bk></cellMetadata>' +
  "</metadata>";

const attribute = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
const unescapeXml = (text: string) =>
  text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, entity: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()]!;
    return String.fromCodePoint(
      entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)),
    );
  });

/** Worksheet part paths by sheet name, from the workbook part and its relationships. */
export function sheetParts(files: Unzipped) {
  const workbook = files["xl/workbook.xml"];
  const rels = files["xl/_rels/workbook.xml.rels"];
  const parts = new Map<string, string>();
  if (!workbook || !rels) return parts;
  const targets = new Map<string, string>();
  for (const [tag] of strFromU8(rels).matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attribute(tag, "Id");
    const target = attribute(tag, "Target");
    if (id && target)
      targets.set(
        id,
        target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`,
      );
  }
  for (const [tag] of strFromU8(workbook).matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
    const name = attribute(tag, "name");
    const id = attribute(tag, "r:id") ?? /\s\w+:id="([^"]*)"/.exec(tag)?.[1];
    const target = id ? targets.get(id) : undefined;
    if (name && target) parts.set(unescapeXml(name), target);
  }
  return parts;
}

/** Reads which array formulas of a just-opened file are dynamic. */
export function readDynamicCells(workbook: Workbook, bytes: Uint8Array) {
  const metadata = workbook.passthrough?.get(METADATA);
  if (!metadata) return;
  const text = strFromU8(metadata);
  const types = [...text.matchAll(/<metadataType\b[^>]*>/g)].map(([tag]) => attribute(tag, "name"));
  const block = /<cellMetadata\b[^>]*>([\s\S]*?)<\/cellMetadata>/.exec(text)?.[1] ?? "";
  const dynamic = new Set<string>();
  [...block.matchAll(/<bk>([\s\S]*?)<\/bk>/g)].forEach(([, body], index) => {
    const type = /<rc\b[^>]*\st="(\d+)"/.exec(body!)?.[1];
    if (type && types[Number(type) - 1] === "XLDAPR") dynamic.add(String(index + 1));
  });
  if (!dynamic.size) return;
  const files = unzipSync(bytes, {
    filter: (file) =>
      file.name === "xl/workbook.xml" ||
      file.name === "xl/_rels/workbook.xml.rels" ||
      (file.name.startsWith("xl/worksheets/") && file.name.endsWith(".xml")),
  });
  const parts = sheetParts(files);
  for (const sheet of iterWorksheets(workbook)) {
    const part = parts.get(sheet.title);
    const xml = part ? files[part] : undefined;
    if (!xml) continue;
    for (const [tag] of strFromU8(xml).matchAll(/<c\b[^>]*>/g)) {
      const mark = attribute(tag, "cm");
      const address = attribute(tag, "r");
      if (!mark || !address || !dynamic.has(mark)) continue;
      const match = /^([A-Z]+)(\d+)$/.exec(address);
      if (!match) continue;
      const cell = getCell(sheet, Number(match[2]), columnIndex(match[1]!));
      if (cell && isFormulaValue(cell.value) && cell.value.t === "array")
        markDynamic(workbook, sheet, cell);
    }
  }
}

/** The dynamic formulas still standing, by sheet: each an array formula's first cell. */
function standing(workbook: Workbook) {
  const found = new Map<Worksheet, Set<string>>();
  const sheets = registry.get(workbook);
  if (!sheets) return found;
  for (const sheet of iterWorksheets(workbook)) {
    const cells = sheets.get(sheet);
    if (!cells) continue;
    const addresses = new Set<string>();
    for (const cell of cells)
      if (
        getCell(sheet, cell.row, cell.col) === cell &&
        isFormulaValue(cell.value) &&
        cell.value.t === "array"
      )
        addresses.add(`${columnLetters(cell.col)}${cell.row}`);
    if (addresses.size) found.set(sheet, addresses);
  }
  return found;
}

/** Before saving: the metadata part the marks will point at. */
export function prepareDynamicArrays(workbook: Workbook) {
  if (!standing(workbook).size) return;
  workbook.passthrough ??= new Map();
  workbook.passthrough.set(METADATA, strToU8(DYNAMIC_METADATA));
  workbook.passthroughContentTypes ??= new Map();
  workbook.passthroughContentTypes.set(METADATA, METADATA_TYPE);
  const rels = workbook.workbookRelsExtras ?? [];
  if (!rels.some((rel) => rel.type === METADATA_REL))
    workbook.workbookRelsExtras = [
      ...rels,
      { id: "rIdDynamicArrays", type: METADATA_REL, target: "metadata.xml" },
    ];
}

/** After saving: marks each dynamic formula's cell, pointing at the metadata part. */
export function markDynamicArrays(workbook: Workbook, bytes: Uint8Array): Uint8Array {
  const marked = standing(workbook);
  if (!marked.size) return bytes;
  const files = unzipSync(bytes);
  const parts = sheetParts(files);
  for (const [sheet, addresses] of marked) {
    const part = parts.get(sheet.title);
    const xml = part ? files[part] : undefined;
    if (!part || !xml) continue;
    files[part] = strToU8(
      strFromU8(xml).replace(/<c\b([^>]*)>/g, (tag, attributes: string) => {
        const address = attribute(tag, "r");
        if (!address || !addresses.has(address)) return tag;
        const clean = attributes.replace(/\scm="[^"]*"/, "");
        return clean.endsWith("/") ? `<c${clean.slice(0, -1)} cm="1"/>` : `<c${clean} cm="1">`;
      }),
    );
  }
  return zipSync(files, { level: 6 });
}
