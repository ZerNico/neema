// Loaded by the Word worker under plain Node in development: relative imports only.
import {
  addBulletList,
  addNumberedList,
  addStyle,
  addTable,
  appendPageBreak,
  appendParagraph,
  appendTableRow,
  appendTextRun,
  applyListToParagraph,
  createDocx,
  ensureHeadingStyles,
  findStyleIdByName,
  footers,
  getParagraphAlignment,
  getParagraphNumbering,
  getParagraphStyle,
  getRunFormat,
  headers,
  listStyles,
  openDocx,
  outline,
  PAGE_SIZE_A4,
  PAGE_SIZE_LETTER,
  addFooter,
  addFootnote,
  addHeader,
  addHyperlink,
  addPageNumberFooter,
  addTableOfContents,
  imageReferences,
  images,
  insertImageInto,
  removeTableRow,
  replaceText,
  replaceTextEverywhere,
  setPageOrientation,
  setPageMargins,
  setPageSize,
  stylesPart,
  setParagraphAlignment,
  setParagraphStyle,
  setTableBorders,
  setTableCellText,
  setTableRowAsHeader,
  setTitle,
  statistics,
  title,
  toUint8Array,
  validate,
  type Docx,
  type ParagraphAlignment,
  type RunFormatting,
  type WmlBlock,
  type WmlParagraph,
  type WmlTable,
} from "@office-kit/docx";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { readOfficePackage } from "../../office/server/package.ts";
import { WordError } from "../errors.ts";
import { pictureOf } from "./picture.ts";
import { WORD_LIMITS } from "../limits.ts";
import {
  parseWordOperations,
  type NewParagraph,
  type ParagraphStyle,
  type WordOperation,
} from "../operations.ts";

const fail = (code: string, message: string): never => {
  throw new WordError(code, message);
};

/**
 * Inflates every part once through the shared package reader, counting what it
 * really expands to (a zip's own sizes can lie), before the parser sees a byte.
 * Macros, ActiveX controls and embedded objects are active content, never run
 * or passed on.
 */
function checkPackage(bytes: Uint8Array) {
  const names = readOfficePackage(bytes, {
    limits: {
      archiveBytes: WORD_LIMITS.compressedBytes,
      entries: WORD_LIMITS.parts,
      entryBytes: WORD_LIMITS.partBytes,
      expandedBytes: WORD_LIMITS.expandedBytes,
      expansionRatio: WORD_LIMITS.expansionRatio,
    },
    fail: (kind) =>
      kind === "entries"
        ? fail("limit", `A Word file can have at most ${WORD_LIMITS.parts} parts.`)
        : kind === "size"
          ? fail("limit", "This Word file expands past the size the app can open.")
          : fail("invalid_file", "This is not a Word file the app can open."),
  });
  if (!names.includes("[Content_Types].xml"))
    fail("invalid_file", "This is not a Word file the app can open.");
  const lower = names.map((name) => name.toLowerCase());
  if (lower.some((name) => name.endsWith("vbaproject.bin")))
    fail(
      "unsupported_content",
      "Macro-enabled documents aren't supported; save it as .docx without macros.",
    );
  if (lower.some((name) => name.startsWith("word/activex/") || name.startsWith("word/embeddings/")))
    fail("unsupported_content", "Documents with embedded objects or controls aren't supported.");
}

/** Opens a Word file within the bounds. */
export function openWordFile(bytes: Uint8Array): Docx {
  if (bytes.length > WORD_LIMITS.compressedBytes)
    fail("limit", `A Word file can be at most ${WORD_LIMITS.compressedBytes / 1024 / 1024} MiB.`);
  checkPackage(bytes);
  let doc: Docx;
  try {
    doc = openDocx(bytes);
  } catch (error) {
    return fail(
      "invalid_file",
      `This is not a Word file the app can open: ${error instanceof Error ? error.message.slice(0, 200) : "unreadable"}`,
    );
  }
  if (doc.document.body.blocks.length > WORD_LIMITS.blocks)
    fail("limit", `A Word file can have at most ${WORD_LIMITS.blocks} paragraphs and tables.`);
  return doc;
}

/** Word needs a paragraph to end the body: a document may not end in a table or be empty. */
function closeBody(doc: Docx) {
  const blocks = doc.document.body.blocks;
  if (blocks.length === 0 || blocks.at(-1)!.kind !== "paragraph") appendParagraph(doc, "");
}

const SETTINGS_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml";
const SETTINGS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings";
/** Settings elements that come after `updateFields` in the schema's fixed order. */
const AFTER_UPDATE_FIELDS = [
  "hdrShapeDefaults",
  "footnotePr",
  "endnotePr",
  "compat",
  "docVars",
  "rsids",
  "mathPr",
  "attachedSchema",
  "themeFontLang",
  "clrSchemeMapping",
  "doNotIncludeSubdocsInStats",
  "doNotAutoCompressPictures",
  "forceUpgrade",
  "captions",
  "readModeInkLockDown",
  "smartTagType",
  "schemaLibrary",
  "shapeDefaults",
  "doNotEmbedSmartTags",
  "decimalSymbol",
  "listSeparator",
];

/** Bullet characters by level, as Word's own lists cycle them, in fonts that have them. */
const BULLETS = [
  { glyph: "\u2022", font: "Arial" },
  { glyph: "o", font: "Courier New" },
  { glyph: "\u25AA", font: "Arial" },
];

/**
 * The library writes bullet levels without their character (and the second
 * with Symbol's "o", an omicron), so Word draws nothing. Any bullet level with
 * no character, or that omicron, gets Word's usual one.
 */
function repairBullets(xml: string) {
  return xml.replace(/<w:lvl\b[^>]*>[\s\S]*?<\/w:lvl>/g, (level) => {
    const empty = /<w:lvlText w:val=""\/>/.test(level);
    const omicron = /<w:lvlText w:val="o"\/>/.test(level) && /w:ascii="Symbol"/.test(level);
    if (!/<w:numFmt w:val="bullet"\/>/.test(level) || (!empty && !omicron)) return level;
    const bullet = BULLETS[Number(/w:ilvl="(\d+)"/.exec(level)?.[1] ?? 0) % BULLETS.length]!;
    return level
      .replace(/<w:lvlText w:val="o?"\/>/, `<w:lvlText w:val="${bullet.glyph}"/>`)
      .replace(
        /<w:rFonts\b[^>]*\/>/,
        `<w:rFonts w:ascii="${bullet.font}" w:hAnsi="${bullet.font}" w:hint="default"/>`,
      );
  });
}

/**
 * What the saved package needs that the library doesn't model:
 * - bullets Word can draw (see `repairBullets`);
 * - a settings part for a document without one, declaring the current Word
 *   version, or Word opens it in Compatibility Mode;
 * - `updateFields` when there is a table of contents, a field Word fills in:
 *   without it Word shows the placeholder until someone updates it.
 */
function finishPackage(bytes: Uint8Array): Uint8Array {
  const files = unzipSync(bytes);
  let changed = false;
  const numbering = files["word/numbering.xml"];
  if (numbering) {
    const xml = strFromU8(numbering);
    const repaired = repairBullets(xml);
    if (repaired !== xml) {
      files["word/numbering.xml"] = strToU8(repaired);
      changed = true;
    }
  }
  const main = files["word/document.xml"];
  const toc = !!main && /<w:instrText[^>]*>\s*TOC\b/.test(strFromU8(main));
  const flag = '<w:updateFields w:val="true"/>';
  const existing = files["word/settings.xml"];
  if (existing) {
    const xml = strFromU8(existing);
    if (toc && !xml.includes("<w:updateFields")) {
      const next = AFTER_UPDATE_FIELDS.map((name) => xml.search(new RegExp(`<w:${name}[\\s/>]`)))
        .filter((at) => at >= 0)
        .toSorted((a, b) => a - b)[0];
      const at = next ?? xml.lastIndexOf("</w:settings>");
      if (at >= 0) {
        files["word/settings.xml"] = strToU8(xml.slice(0, at) + flag + xml.slice(at));
        changed = true;
      }
    }
  } else {
    // updateFields comes before compat in the settings schema.
    files["word/settings.xml"] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:settings xmlns:w="${WORD_NS}">${toc ? flag : ""}<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`,
    );
    const types = strFromU8(files["[Content_Types].xml"]!);
    files["[Content_Types].xml"] = strToU8(
      types.replace(
        "</Types>",
        `<Override PartName="/word/settings.xml" ContentType="${SETTINGS_TYPE}"/></Types>`,
      ),
    );
    const relsPath = "word/_rels/document.xml.rels";
    const rels = strFromU8(files[relsPath]!);
    files[relsPath] = strToU8(
      rels.replace(
        "</Relationships>",
        `<Relationship Id="rIdSettings" Type="${SETTINGS_REL}" Target="settings.xml"/></Relationships>`,
      ),
    );
    changed = true;
  }
  return changed ? zipSync(files, { level: 6 }) : bytes;
}

const save = (doc: Docx) => {
  closeBody(doc);
  const bytes = finishPackage(toUint8Array(doc));
  if (bytes.length > WORD_LIMITS.compressedBytes)
    fail("limit", "The edited document would exceed the size limit.");
  return bytes;
};

export function createWordFile() {
  return save(createDocx());
}

// ---------------------------------------------------------------------------
// Reading

type XmlElement = Extract<WmlBlock, { kind: "raw" }>["node"];
/** Visible text of raw markup (hyperlinks, content controls, insertions); deleted text is left out. */
function xmlText(node: XmlElement): string {
  let text = "";
  for (const child of node.children) {
    if (child.kind === "text" && node.name.local === "t") text += child.value;
    else if (child.kind === "element") {
      if (child.name.local === "del" || child.name.local === "delText") continue;
      if (child.name.local === "tab") text += "\t";
      else if (child.name.local === "br" || child.name.local === "cr") text += "\n";
      else text += xmlText(child);
    }
  }
  return text;
}

interface Run {
  readonly text: string;
  readonly bold?: true;
  readonly italic?: true;
  readonly underline?: true;
  /** Set directly on the text, as #RRGGBB. */
  readonly color?: string;
}
const hexColor = (value: string | undefined) =>
  value && /^[0-9a-f]{6}$/i.test(value) ? `#${value.toUpperCase()}` : undefined;
/** A paragraph as formatted runs of visible text, adjacent same-format runs joined. */
function runsOf(paragraph: WmlParagraph): Run[] {
  const runs: Run[] = [];
  const push = (text: string, format: RunFormatting = {}) => {
    if (!text) return;
    const run: Run = {
      text,
      ...(format.bold ? { bold: true as const } : {}),
      ...(format.italic ? { italic: true as const } : {}),
      ...(format.underline && format.underline !== "none" ? { underline: true as const } : {}),
      ...(hexColor(format.color) ? { color: hexColor(format.color)! } : {}),
    };
    const last = runs.at(-1);
    if (
      last &&
      last.bold === run.bold &&
      last.italic === run.italic &&
      last.underline === run.underline &&
      last.color === run.color
    )
      runs[runs.length - 1] = { ...last, text: last.text + text };
    else runs.push(run);
  };
  for (const child of paragraph.children) {
    if (child.kind === "raw") {
      push(xmlText(child.node));
      continue;
    }
    const format = getRunFormat(child);
    let text = "";
    for (const piece of child.pieces)
      text +=
        piece.kind === "text"
          ? piece.value
          : piece.kind === "tab"
            ? "\t"
            : piece.kind === "break" && piece.breakType !== "page" && piece.breakType !== "column"
              ? "\n"
              : piece.kind === "noBreakHyphen"
                ? "-"
                : "";
    push(text, format);
  }
  return runs;
}
const textOf = (paragraph: WmlParagraph) =>
  runsOf(paragraph)
    .map((run) => run.text)
    .join("");
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

const pageBreakOnly = (paragraph: WmlParagraph) =>
  paragraph.children.length > 0 &&
  paragraph.children.every(
    (child) =>
      child.kind === "run" &&
      child.pieces.every((piece) => piece.kind === "break" && piece.breakType === "page"),
  );

/** Word's built-in style names, the same in every language; ids are localized. */
const STYLE_NAMES: Record<ParagraphStyle, string> = {
  normal: "Normal",
  title: "Title",
  heading1: "heading 1",
  heading2: "heading 2",
  heading3: "heading 3",
  heading4: "heading 4",
  heading5: "heading 5",
  heading6: "heading 6",
  quote: "Quote",
};

function roleOf(doc: Docx, paragraph: WmlParagraph, levels: Map<WmlParagraph, number>) {
  const style = getParagraphStyle(paragraph);
  const level = levels.get(paragraph);
  if (style && (style === findStyleIdByName(doc, "Title") || style === "Title"))
    return { role: "title" as const };
  if (level !== undefined) return { role: "heading" as const, level };
  const numbering = getParagraphNumbering(paragraph);
  if (numbering) return { role: "list" as const, level: numbering.ilvl };
  if (style && (style === findStyleIdByName(doc, "Quote") || style === "Quote"))
    return { role: "quote" as const };
  return { role: "body" as const };
}

const tableRows = (table: WmlTable, maxRows: number, maxColumns: number, cellChars: number) =>
  table.rows
    .slice(0, maxRows)
    .map((row) =>
      row.cells
        .slice(0, maxColumns)
        .map((cell) => clip(cell.paragraphs.map(textOf).join("\n"), cellChars)),
    );
const tableShape = (table: WmlTable) => ({
  rowCount: table.rows.length,
  columnCount: Math.max(0, ...table.rows.map((row) => row.cells.length)),
});

/** Every element named `local` at or under `node`. */
function elementsNamed(node: XmlElement, local: string, found: XmlElement[] = []) {
  if (node.name.local === local) found.push(node);
  for (const child of node.children)
    if (child.kind === "element") elementsNamed(child, local, found);
  return found;
}
const textIn = (node: XmlElement): string =>
  node.children
    .map((child) =>
      child.kind === "text" ? child.value : child.kind === "element" ? textIn(child) : "",
    )
    .join("");

/** The pictures in a paragraph: in its runs, and inside links or content controls. */
function drawingsOf(paragraph: WmlParagraph): XmlElement[] {
  return paragraph.children.flatMap((child) =>
    child.kind === "raw"
      ? elementsNamed(child.node, "drawing")
      : child.pieces.flatMap((piece) =>
          piece.kind === "drawing" || piece.kind === "pict" ? [piece.node] : [],
        ),
  );
}

/** The deepest heading level a table-of-contents field in this block lists, or null without one. */
function tocLevels(item: WmlBlock): number | null {
  const instruction =
    item.kind === "paragraph"
      ? item.children
          .map((child) =>
            child.kind === "raw"
              ? elementsNamed(child.node, "instrText").map(textIn).join("")
              : child.pieces
                  .map((piece) => (piece.kind === "instrText" ? piece.value : ""))
                  .join(""),
          )
          .join("")
      : item.kind === "raw"
        ? elementsNamed(item.node, "instrText").map(textIn).join("")
        : "";
  if (!/^\s*TOC\b/.test(instruction)) return null;
  const range = /\\o\s+"\d+-(\d+)"/.exec(instruction);
  return range ? Number(range[1]) : 3;
}

export interface InspectScope {
  /** The first block to show. */
  readonly from?: number;
}

/** The model's view of a Word file: structure first, then a window of blocks with their text. */
export function inspectWordFile(bytes: Uint8Array, scope: InspectScope = {}) {
  const doc = openWordFile(bytes);
  const blocks = doc.document.body.blocks;
  const levels = new Map(outline(doc).map((item) => [item.paragraph, item.level]));
  const from = Math.min(Math.max(0, scope.from ?? 0), blocks.length);
  const window: Array<Record<string, unknown>> = [];
  let chars = 0;
  let next: number | null = null;
  for (let index = from; index < blocks.length; index++) {
    if (window.length >= WORD_LIMITS.windowBlocks || chars >= WORD_LIMITS.windowChars) {
      next = index;
      break;
    }
    const item = blocks[index]!;
    const toc = tocLevels(item);
    if (toc !== null) {
      window.push({ block: index, type: "tableOfContents", levels: toc });
      continue;
    }
    if (item.kind === "paragraph") {
      const text = textOf(item);
      chars += text.length;
      const style = getParagraphStyle(item);
      const pictures = drawingsOf(item).length;
      window.push({
        block: index,
        type: pageBreakOnly(item) ? "pageBreak" : "paragraph",
        ...roleOf(doc, item, levels),
        ...(style ? { style } : {}),
        text: clip(text, WORD_LIMITS.paragraphChars),
        ...(pictures ? { pictures } : {}),
      });
    } else if (item.kind === "table") {
      const rows = tableRows(
        item,
        WORD_LIMITS.tableRows,
        WORD_LIMITS.tableColumns,
        WORD_LIMITS.cellChars,
      );
      chars += rows.flat().reduce((sum, cell) => sum + cell.length, 0);
      window.push({ block: index, type: "table", ...tableShape(item), rows });
    } else {
      const text = xmlText(item.node);
      chars += text.length;
      window.push({ block: index, type: "other", text: clip(text, 2_000) });
    }
  }
  const everything = [
    ...blocks.flatMap((item) => (item.kind === "paragraph" ? [textOf(item)] : [])),
    ...cellParagraphs(blocks).map(textOf),
    ...headers(doc).map((part) => part.text),
    ...footers(doc).map((part) => part.text),
  ].join("\n");
  const placeholders = [
    ...new Set(
      everything.match(/\{\{[^{}\n]{1,80}\}\}|\[\[[^[\]\n]{1,80}\]\]|«[^«»\n]{1,80}»/g) ?? [],
    ),
  ];
  const stats = statistics(doc);
  const documentTitle = title(doc);
  return {
    blockCount: blocks.length,
    ...(documentTitle ? { title: clip(documentTitle, 300) } : {}),
    outline: blocks
      .flatMap((item, index) =>
        item.kind === "paragraph" && levels.has(item)
          ? [{ block: index, level: levels.get(item)!, text: clip(textOf(item), 200) }]
          : [],
      )
      .slice(0, 300),
    headers: headers(doc)
      .map((part) => clip(part.text, 1_000))
      .filter(Boolean)
      .slice(0, 6),
    footers: footers(doc)
      .map((part) => clip(part.text, 1_000))
      .filter(Boolean)
      .slice(0, 6),
    placeholders: placeholders.slice(0, 50),
    // Where page numbers show, so the model changes them rather than adding a second set.
    pageNumbers: (["header", "footer"] as const).filter((kind) => {
      const part = pagePart(doc, kind);
      return !!part && PAGE_FIELD.test(strFromU8(part.data));
    }),
    firstPageDifferent: !!childNamed(doc.document.body.sectPr, "titlePg"),
    styles: paragraphStyles(doc)
      .map((each) => each.name)
      .slice(0, 150),
    words: stats.words,
    tables: stats.tables,
    images: stats.images,
    footnotes: stats.footnotes,
    blocks: window,
    ...(next === null ? {} : { nextBlock: next }),
  };
}

/** How a style's text looks, followed through `basedOn`: what a preview shows of it. */
function styleLook(doc: Docx) {
  const byId = new Map(
    (stylesPart(doc)?.styles ?? []).map((each) => [attributeOf(each, "styleId") ?? "", each]),
  );
  const cache = new Map<string, Record<string, string | number | boolean>>();
  const look = (id: string, depth = 0): Record<string, string | number | boolean> => {
    const known = cache.get(id);
    if (known) return known;
    const style = byId.get(id);
    if (!style || depth > 10) return {};
    const basedOn = childNamed(style, "basedOn");
    const inherited = basedOn ? look(attributeOf(basedOn, "val") ?? "", depth + 1) : {};
    const run = childNamed(style, "rPr");
    const own: Record<string, string | number | boolean> = {};
    const value = (local: string) => {
      const found = childNamed(run, local);
      return found && attributeOf(found, "val");
    };
    const color = hexColor(value("color"));
    if (color) own.color = color;
    const size = Number(value("sz"));
    if (size > 0) own.size = size / 2;
    const fonts = childNamed(run, "rFonts");
    const font = fonts && attributeOf(fonts, "ascii");
    if (font && /^[\w .-]{1,60}$/.test(font)) own.font = font;
    for (const [local, key] of [
      ["b", "bold"],
      ["i", "italic"],
    ] as const) {
      const flag = childNamed(run, local);
      if (flag) own[key] = !["0", "false", "off"].includes(attributeOf(flag, "val") ?? "");
    }
    const result = { ...inherited, ...own };
    cache.set(id, result);
    return result;
  };
  return look;
}

const toRoman = (value: number) => {
  let rest = value;
  let out = "";
  for (const [digit, letters] of [
    [1000, "m"],
    [900, "cm"],
    [500, "d"],
    [400, "cd"],
    [100, "c"],
    [90, "xc"],
    [50, "l"],
    [40, "xl"],
    [10, "x"],
    [9, "ix"],
    [5, "v"],
    [4, "iv"],
    [1, "i"],
  ] as const)
    while (rest >= digit) {
      out += letters;
      rest -= digit;
    }
  return out;
};
const toLetters = (value: number) => {
  let rest = value;
  let out = "";
  while (rest > 0) {
    out = String.fromCharCode(97 + ((rest - 1) % 26)) + out;
    rest = Math.floor((rest - 1) / 26);
  }
  return out;
};

/**
 * List markers as Word counts them: numbers per list and level, deeper levels
 * restarting when a shallower one moves on, written in each level's format.
 */
function listMarkers(doc: Docx) {
  const entry = [...doc.opc.parts.values()].find((part) =>
    part.contentType.includes("numbering+xml"),
  );
  const xml = entry ? strFromU8(entry.data) : "";
  const levels = new Map<string, Map<number, { format: string; text: string; start: number }>>();
  for (const [abstract, id] of xml.matchAll(
    /<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>[\s\S]*?<\/w:abstractNum>/g,
  )) {
    const byLevel = new Map<number, { format: string; text: string; start: number }>();
    for (const [level] of abstract.matchAll(/<w:lvl\b[\s\S]*?<\/w:lvl>/g))
      byLevel.set(Number(/w:ilvl="(\d+)"/.exec(level)?.[1] ?? 0), {
        format: /<w:numFmt w:val="([^"]*)"/.exec(level)?.[1] ?? "decimal",
        text: /<w:lvlText w:val="([^"]*)"/.exec(level)?.[1] ?? "",
        start: Number(/<w:start w:val="(\d+)"/.exec(level)?.[1] ?? 1),
      });
    levels.set(id!, byLevel);
  }
  const abstractOf = new Map(
    [
      ...xml.matchAll(/<w:num\b[^>]*w:numId="(\d+)"[^>]*>[\s\S]*?<w:abstractNumId w:val="(\d+)"/g),
    ].map(([, num, abstract]) => [Number(num), abstract!]),
  );
  const counters = new Map<number, number[]>();
  const written = (value: number, format: string) =>
    format === "lowerRoman"
      ? toRoman(value)
      : format === "upperRoman"
        ? toRoman(value).toUpperCase()
        : format === "lowerLetter"
          ? toLetters(value)
          : format === "upperLetter"
            ? toLetters(value).toUpperCase()
            : String(value);
  return (numId: number, level: number) => {
    const defined = levels.get(abstractOf.get(numId) ?? "");
    const own = defined?.get(level);
    if (!own || own.format === "bullet" || own.format === "none") {
      // Word's bullets live in symbol fonts' private range; show them as the bullets they are.
      const glyph = own?.text ?? "";
      return !glyph || /[\uF000-\uF0FF]/.test(glyph) ? "\u2022" : glyph === "o" ? "\u25E6" : glyph;
    }
    const counts = counters.get(numId) ?? [];
    counts[level] = (counts[level] ?? own.start - 1) + 1;
    counts.length = level + 1;
    counters.set(numId, counts);
    return own.text.replace(/%(\d)/g, (_, digit: string) => {
      const at = Number(digit) - 1;
      return written(
        counts[at] ?? defined?.get(at)?.start ?? 1,
        defined?.get(at)?.format ?? "decimal",
      );
    });
  };
}

/**
 * What a person sees of the document, as data for the client to lay out:
 * roles, runs with bold, italic and underline, and tables. Never markup.
 */
export function previewWordFile(bytes: Uint8Array) {
  const doc = openWordFile(bytes);
  const blocks = doc.document.body.blocks;
  const levels = new Map(outline(doc).map((item) => [item.paragraph, item.level]));
  const shown: Array<Record<string, unknown>> = [];
  let chars = 0;
  let truncated = false;
  // Pictures travel as data URLs, PNG and JPEG only as their bytes say, within a budget.
  const parts = new Map(imageReferences(doc).map((each) => [each.relId, each.partName]));
  const data = new Map(images(doc).map((each) => [each.partName, each.data]));
  let pictureBytes = 0;
  const looks = styleLook(doc);
  const marker = listMarkers(doc);
  const pictureOfDrawing = (drawing: XmlElement) => {
    const extent = elementsNamed(drawing, "extent")[0];
    const width = Math.round(Number(extent ? attributeOf(extent, "cx") : 0) / 9_525) || 100;
    const height = Math.round(Number(extent ? attributeOf(extent, "cy") : 0) / 9_525) || 100;
    const described = elementsNamed(drawing, "docPr")[0];
    const alt = (described && attributeOf(described, "descr")) ?? "";
    const blip = elementsNamed(drawing, "blip")[0];
    const part = parts.get((blip && attributeOf(blip, "embed")) ?? "");
    const bytes = part ? data.get(part) : undefined;
    const kind = bytes ? pictureOf(bytes) : null;
    const fits =
      bytes &&
      kind &&
      bytes.length <= WORD_LIMITS.previewPictureBytes &&
      pictureBytes + bytes.length <= WORD_LIMITS.previewPicturesBytes;
    if (!fits) return { width, height, alt: clip(alt, 300) };
    pictureBytes += bytes.length;
    return {
      width,
      height,
      alt: clip(alt, 300),
      src: `data:${kind.mediaType};base64,${Buffer.from(bytes).toString("base64")}`,
    };
  };
  for (const item of blocks) {
    if (shown.length >= WORD_LIMITS.previewBlocks || chars >= WORD_LIMITS.previewChars) {
      truncated = true;
      break;
    }
    const toc = tocLevels(item);
    if (toc !== null) {
      // Word fills the field in when it opens the file; the preview lists what it will find.
      shown.push({
        type: "tableOfContents",
        entries: [...levels]
          .filter(([, level]) => level <= toc)
          .slice(0, 300)
          .map(([paragraph, level]) => ({ level, text: clip(textOf(paragraph), 200) })),
      });
      continue;
    }
    if (item.kind === "paragraph") {
      if (pageBreakOnly(item)) {
        shown.push({ type: "pageBreak" });
        continue;
      }
      const runs = runsOf(item);
      chars += runs.reduce((sum, run) => sum + run.text.length, 0);
      const align = getParagraphAlignment(item);
      const pictures = drawingsOf(item).map(pictureOfDrawing);
      const role = roleOf(doc, item, levels);
      const numbering = role.role === "list" ? getParagraphNumbering(item) : undefined;
      const style = getParagraphStyle(item);
      // Titles and headings carry the document's own look, as Word shows them.
      const look = (role.role === "title" || role.role === "heading") && style ? looks(style) : {};
      shown.push({
        type: "paragraph",
        ...role,
        ...(numbering ? { marker: marker(numbering.numId, numbering.ilvl) } : {}),
        ...(Object.keys(look).length ? { look } : {}),
        ...(align === "center" || align === "right" || align === "both" ? { align } : {}),
        runs,
        ...(pictures.length ? { pictures } : {}),
      });
    } else if (item.kind === "table") {
      const rows = tableRows(item, 200, 20, 2_000);
      chars += rows.flat().reduce((sum, cell) => sum + cell.length, 0);
      shown.push({ type: "table", rows });
    } else {
      const text = xmlText(item.node);
      chars += text.length;
      if (text) shown.push({ type: "paragraph", role: "body", runs: [{ text }] });
    }
  }
  return { blocks: shown, truncated, images: statistics(doc).images };
}
export type WordPreview = ReturnType<typeof previewWordFile>;

/** Paragraphs inside table cells, which the library's body-wide functions pass over. */
const cellParagraphs = (blocks: readonly WmlBlock[]) =>
  blocks.flatMap((item) =>
    item.kind === "table"
      ? item.rows.flatMap((row) => row.cells.flatMap((cell) => cell.paragraphs))
      : [],
  );

/**
 * Runs a body-wide library function over the paragraphs in table cells, by
 * lending it them as the body for the call; the body is restored even on failure.
 */
function inTableCells<T>(doc: Docx, run: () => T): T {
  const body = doc.document.body;
  const blocks = body.blocks;
  body.blocks = cellParagraphs(blocks);
  try {
    return run();
  } finally {
    body.blocks = blocks;
  }
}

// ---------------------------------------------------------------------------
// Editing

/** Inline **bold**, *italic* and `code`, as the runs they describe; `\\*` is a literal star. */
type InlineRun = { text: string; format: RunFormatting; link?: string };
export function inlineRuns(text: string): InlineRun[] {
  const runs: InlineRun[] = [];
  const pattern =
    /\\([*`\\_[])|\[([^\]\n]+)\]\(([^()\s]+)\)|\*\*(.+?)\*\*|\*(?!\s)(.+?)\*|`([^`]+)`/gs;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) runs.push({ text: text.slice(last, match.index), format: {} });
    if (match[1] !== undefined) runs.push({ text: match[1], format: {} });
    else if (match[2] !== undefined) runs.push({ text: match[2], format: {}, link: match[3]! });
    else if (match[4] !== undefined)
      runs.push(
        ...inlineRuns(match[4]).map((run) => ({ ...run, format: { ...run.format, bold: true } })),
      );
    else if (match[5] !== undefined)
      runs.push(
        ...inlineRuns(match[5]).map((run) => ({ ...run, format: { ...run.format, italic: true } })),
      );
    else runs.push({ text: match[6]!, format: { font: "Consolas" } });
    last = match.index + match[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), format: {} });
  return runs.filter((run) => run.text);
}

/** A link target a reader may follow: web and mail only, never files or scripts. */
function linkTarget(raw: string) {
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:")
      return url.href;
  } catch {
    // Reported below.
  }
  return fail(
    "invalid_operation",
    `links must be http, https or mailto addresses; "${clip(raw, 80)}" is not one.`,
  );
}

/** Replaces a paragraph's runs, keeping its paragraph properties and the first run's look. */
function fill(doc: Docx, paragraph: WmlParagraph, text: string, base: RunFormatting = {}) {
  paragraph.children.length = 0;
  paragraph.extras.length = 0;
  for (const run of inlineRuns(text)) {
    if (!run.link) {
      appendTextRun(paragraph, run.text, { ...base, ...run.format });
      continue;
    }
    // The library builds a link only as a paragraph of its own; borrow its link and drop it.
    const carrier = addHyperlink(doc, linkTarget(run.link), run.text);
    const blocks = doc.document.body.blocks;
    blocks.splice(blocks.indexOf(carrier), 1);
    paragraph.children.push(...carrier.children);
  }
}

/** Paragraph styles the document defines: id and display name. */
function paragraphStyles(doc: Docx) {
  return (stylesPart(doc)?.styles ?? []).flatMap((element) => {
    if (attributeOf(element, "type") !== "paragraph") return [];
    const id = attributeOf(element, "styleId");
    const named = element.children.find(
      (child): child is XmlElement => child.kind === "element" && child.name.local === "name",
    );
    return id ? [{ id, name: (named && attributeOf(named, "val")) ?? id }] : [];
  });
}

/**
 * A style's id: a built-in one is found by Word's own name (and added when a
 * new document lacks it); any other must be a paragraph style the document
 * defines, by name or id.
 */
function styleId(doc: Docx, style: string): string | undefined {
  if (Object.hasOwn(STYLE_NAMES, style)) return builtInStyle(doc, style as ParagraphStyle);
  const wanted = style.toLowerCase();
  const found = paragraphStyles(doc).find(
    (each) => each.name.toLowerCase() === wanted || each.id.toLowerCase() === wanted,
  );
  if (found) return found.id;
  const names = paragraphStyles(doc).map((each) => each.name);
  return fail(
    "not_found",
    `no paragraph style "${clip(style, 60)}"; this document has ${clip(names.join(", "), 400)}.`,
  );
}

function builtInStyle(doc: Docx, style: ParagraphStyle): string | undefined {
  if (style === "normal") return undefined;
  const found = findStyleIdByName(doc, STYLE_NAMES[style]);
  if (found) return found;
  if (style.startsWith("heading")) {
    ensureHeadingStyles(doc, 6);
    return findStyleIdByName(doc, STYLE_NAMES[style]) ?? `Heading${style.slice(7)}`;
  }
  const id = style === "title" ? "Title" : "Quote";
  if (!listStyles(doc).some((each) => each.styleId === id))
    addStyle(
      doc,
      style === "title"
        ? {
            type: "paragraph",
            styleId: id,
            name: "Title",
            basedOn: "Normal",
            next: "Normal",
            qFormat: true,
            fontSizeHalfPoints: 56,
          }
        : {
            type: "paragraph",
            styleId: id,
            name: "Quote",
            basedOn: "Normal",
            next: "Normal",
            qFormat: true,
            italic: true,
            color: "404040",
          },
    );
  return id;
}
const ALIGN: Record<string, ParagraphAlignment> = {
  left: "left",
  center: "center",
  right: "right",
  justify: "both",
};

/** New paragraphs appended at the end of the body, to be moved into place. */
function build(doc: Docx, items: readonly NewParagraph[]): WmlParagraph[] {
  const made: WmlParagraph[] = [];
  for (let index = 0; index < items.length;) {
    const item = items[index]!;
    if (item.list) {
      let end = index;
      while (end < items.length && items[end]!.list === item.list) end += 1;
      const group = items.slice(index, end);
      const paragraphs = (item.list === "bullet" ? addBulletList : addNumberedList)(
        doc,
        group.map(() => ""),
      );
      const numbering = getParagraphNumbering(paragraphs[0]!);
      paragraphs.forEach((paragraph, at) => {
        const entry = group[at]!;
        fill(doc, paragraph, entry.text);
        if (entry.level && numbering)
          applyListToParagraph(doc, paragraph, numbering.numId, entry.level);
        if (entry.align) setParagraphAlignment(paragraph, ALIGN[entry.align]!);
      });
      made.push(...paragraphs);
      index = end;
      continue;
    }
    const paragraph = appendParagraph(doc, "");
    setParagraphStyle(paragraph, styleId(doc, item.style ?? "normal"));
    fill(doc, paragraph, item.text);
    if (item.align) setParagraphAlignment(paragraph, ALIGN[item.align]!);
    made.push(paragraph);
    index += 1;
  }
  return made;
}

const EMU_PER_CM = 360_000;
/** The text width of an A4 page with Word's normal margins, the default size cap. */
const TEXT_WIDTH_CM = 16;
const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const REFERENCE = { header: "headerReference", footer: "footerReference" } as const;
const attributeOf = (element: XmlElement, local: string) =>
  element.attrs.find((attr) => attr.name.local === local)?.value;

/** Whether any earlier section has its own properties (and may share this one's headers). */
const sectioned = (doc: Docx) =>
  doc.document.body.blocks.some(
    (item) =>
      item.kind === "paragraph" &&
      !!item.pPr?.children.some(
        (child) => child.kind === "element" && child.name.local === "sectPr",
      ),
  );

/**
 * Replaces the default header or footer of the document's last section. The
 * library only adds references, so the old one is unlinked first; in a
 * one-section document its part goes too, since nothing else can use it.
 */
function setPageText(doc: Docx, kind: "header" | "footer", text: string, pageNumber: boolean) {
  const body = doc.document.body;
  const local = REFERENCE[kind];
  const isDefault = (child: XmlElement["children"][number]): child is XmlElement =>
    child.kind === "element" &&
    child.name.local === local &&
    (attributeOf(child, "type") ?? "default") === "default";
  const old = body.sectPr?.children.filter(isDefault) ?? [];
  if (body.sectPr)
    body.sectPr = {
      ...body.sectPr,
      children: body.sectPr.children.filter((child) => !isDefault(child)),
    };
  if (!sectioned(doc)) {
    const rels = doc.opc.relsBySource.get(doc.partName);
    for (const reference of old) {
      const id = attributeOf(reference, "id");
      const rel = rels?.relationships.find((each) => each.id === id);
      if (!rels || !rel) continue;
      rels.relationships.splice(rels.relationships.indexOf(rel), 1);
      const part = new URL(rel.target, `http://part${doc.partName}`).pathname;
      doc.opc.parts.delete(part);
      doc.opc.order.splice(doc.opc.order.indexOf(part), 1);
      doc.opc.relsBySource.delete(part);
      const overrides = doc.opc.contentTypes.overrides;
      const override = overrides.findIndex((entry) => entry.partName === part);
      if (override >= 0) overrides.splice(override, 1);
    }
  }
  if (text || pageNumber) {
    if (kind === "header") addHeader(doc, text);
    else if (pageNumber) addPageNumberFooter(doc, text ? `${text} ` : "", "");
    else addFooter(doc, text);
  }
  // A section's properties start with its header and footer references.
  orderSection(doc);
}

const wordName = (local: string) => ({ uri: WORD_NS, local, prefix: "w" });
/** A WordprocessingML element, `w:`-prefixed like the rest of the part. */
function element(
  local: string,
  attrs: Record<string, string> = {},
  children: XmlElement["children"] = [],
): XmlElement {
  return {
    kind: "element",
    name: wordName(local),
    attrs: Object.entries(attrs).map(([name, value]) => ({
      name: wordName(name),
      value,
      isNamespaceDecl: false,
    })),
    children,
    xmlSpace: "default",
    selfClosing: children.length === 0,
  };
}
const childNamed = (parent: XmlElement | undefined, local: string) =>
  parent?.children.find(
    (child): child is XmlElement => child.kind === "element" && child.name.local === local,
  );

/** Word reads property elements only in the schema's order; these are those orders. */
const ORDER = {
  style: [
    "name",
    "aliases",
    "basedOn",
    "next",
    "link",
    "autoRedefine",
    "hidden",
    "uiPriority",
    "semiHidden",
    "unhideWhenUsed",
    "qFormat",
    "locked",
    "personal",
    "personalCompose",
    "personalReply",
    "rsid",
    "pPr",
    "rPr",
    "tblPr",
    "trPr",
    "tcPr",
    "tblStylePr",
  ],
  pPr: [
    "pStyle",
    "keepNext",
    "keepLines",
    "pageBreakBefore",
    "framePr",
    "widowControl",
    "numPr",
    "suppressLineNumbers",
    "pBdr",
    "shd",
    "tabs",
    "suppressAutoHyphens",
    "kinsoku",
    "wordWrap",
    "overflowPunct",
    "topLinePunct",
    "autoSpaceDE",
    "autoSpaceDN",
    "bidi",
    "adjustRightInd",
    "snapToGrid",
    "spacing",
    "ind",
    "contextualSpacing",
    "mirrorIndents",
    "suppressOverlap",
    "jc",
    "textDirection",
    "textAlignment",
    "textboxTightWrap",
    "outlineLvl",
    "divId",
    "cnfStyle",
    "rPr",
    "sectPr",
    "pPrChange",
  ],
  rPr: [
    "rStyle",
    "rFonts",
    "b",
    "bCs",
    "i",
    "iCs",
    "caps",
    "smallCaps",
    "strike",
    "dstrike",
    "outline",
    "shadow",
    "emboss",
    "imprint",
    "noProof",
    "snapToGrid",
    "vanish",
    "webHidden",
    "color",
    "spacing",
    "w",
    "kern",
    "position",
    "sz",
    "szCs",
    "highlight",
    "u",
    "effect",
    "bdr",
    "shd",
    "fitText",
    "vertAlign",
    "rtl",
    "cs",
    "em",
    "lang",
    "eastAsianLayout",
    "specVanish",
    "oMath",
  ],
  sectPr: [
    "headerReference",
    "footerReference",
    "footnotePr",
    "endnotePr",
    "type",
    "pgSz",
    "pgMar",
    "paperSrc",
    "pgBorders",
    "lnNumType",
    "pgNumType",
    "cols",
    "formProt",
    "vAlign",
    "noEndnote",
    "titlePg",
    "textDirection",
    "bidi",
    "rtlGutter",
    "docGrid",
    "printerSettings",
    "sectPrChange",
  ],
} as const;

/** `parent` with its `local` child replaced (or removed with null), children in schema order. */
function withChild(
  parent: XmlElement,
  local: string,
  child: XmlElement | null,
  order: readonly string[],
): XmlElement {
  const kept = parent.children.filter(
    (each) => !(each.kind === "element" && each.name.local === local),
  );
  const children = child ? [...kept, child] : kept;
  // Anything the order doesn't name keeps its place after the named ones.
  const rank = (node: XmlElement["children"][number]) => {
    const at = node.kind === "element" ? order.indexOf(node.name.local) : -1;
    return at < 0 ? order.length : at;
  };
  return {
    ...parent,
    children: children.toSorted((a, b) => rank(a) - rank(b)),
    selfClosing: children.length === 0,
  };
}
const onOff = (on: boolean) => (on ? {} : { val: "0" });

/** Changes a paragraph style's definition, so every paragraph using it follows. */
function restyle(doc: Docx, operation: Extract<WordOperation, { kind: "setStyle" }>) {
  const id = styleId(doc, operation.style) ?? builtInStyleId(doc);
  const styles = stylesPart(doc);
  const index = styles?.styles.findIndex((each) => attributeOf(each, "styleId") === id) ?? -1;
  if (!styles || index < 0)
    return fail("not_found", `the style "${operation.style}" has no definition to change.`);
  let style = styles.styles[index]!;
  let run = childNamed(style, "rPr") ?? element("rPr");
  const setRun = (local: string, attrs: Record<string, string> | null) => {
    run = withChild(run, local, attrs ? element(local, attrs) : null, ORDER.rPr);
  };
  if (operation.font)
    setRun("rFonts", {
      ascii: operation.font,
      hAnsi: operation.font,
      cs: operation.font,
      eastAsia: operation.font,
    });
  if (operation.size !== undefined) {
    const half = String(Math.round(operation.size * 2));
    setRun("sz", { val: half });
    setRun("szCs", { val: half });
  }
  if (operation.color) setRun("color", { val: operation.color });
  if (operation.bold !== undefined) {
    setRun("b", onOff(operation.bold));
    setRun("bCs", onOff(operation.bold));
  }
  if (operation.italic !== undefined) {
    setRun("i", onOff(operation.italic));
    setRun("iCs", onOff(operation.italic));
  }
  if (operation.underline !== undefined)
    setRun("u", { val: operation.underline ? "single" : "none" });
  let paragraph = childNamed(style, "pPr") ?? element("pPr");
  if (operation.align)
    paragraph = withChild(
      paragraph,
      "jc",
      element("jc", { val: ALIGN[operation.align]! }),
      ORDER.pPr,
    );
  if (
    operation.spaceBefore !== undefined ||
    operation.spaceAfter !== undefined ||
    operation.lineSpacing !== undefined
  ) {
    const spacing = childNamed(paragraph, "spacing");
    const attrs = Object.fromEntries(
      spacing?.attrs.map((attr) => [attr.name.local, attr.value]) ?? [],
    );
    if (operation.spaceBefore !== undefined)
      attrs.before = String(Math.round(operation.spaceBefore * 20));
    if (operation.spaceAfter !== undefined)
      attrs.after = String(Math.round(operation.spaceAfter * 20));
    if (operation.lineSpacing !== undefined) {
      attrs.line = String(Math.round(operation.lineSpacing * 240));
      attrs.lineRule = "auto";
    }
    paragraph = withChild(paragraph, "spacing", element("spacing", attrs), ORDER.pPr);
  }
  if (paragraph.children.length) style = withChild(style, "pPr", paragraph, ORDER.style);
  if (run.children.length) style = withChild(style, "rPr", run, ORDER.style);
  styles.styles[index] = style;
  doc.stylesDirty = true;
}
/** Normal has no id in `styleId`, which reads it as "no style"; its definition does. */
const builtInStyleId = (doc: Docx) => findStyleIdByName(doc, "Normal") ?? "Normal";

const escapeXml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** The default header or footer part of the last section, if there is one. */
function pagePart(doc: Docx, kind: "header" | "footer") {
  const reference = doc.document.body.sectPr?.children.find(
    (child): child is XmlElement =>
      child.kind === "element" &&
      child.name.local === REFERENCE[kind] &&
      (attributeOf(child, "type") ?? "default") === "default",
  );
  const id = reference && attributeOf(reference, "id");
  const rel = doc.opc.relsBySource.get(doc.partName)?.relationships.find((each) => each.id === id);
  if (!rel) return null;
  return doc.opc.parts.get(new URL(rel.target, `http://part${doc.partName}`).pathname) ?? null;
}

/**
 * Adds paragraphs to the default header or footer, keeping what is in it, or
 * to a new one. The library doesn't model these parts, so the XML is appended
 * in the part's own prefix for WordprocessingML.
 */
function appendToPagePart(doc: Docx, kind: "header" | "footer", paragraphs: (w: string) => string) {
  let part = pagePart(doc, kind);
  let fresh = false;
  if (!part) {
    if (kind === "header") addHeader(doc, "");
    else addFooter(doc, "");
    orderSection(doc);
    part = pagePart(doc, kind);
    fresh = true;
  }
  if (!part) return fail("invalid_operation", `the ${kind} could not be created.`);
  let xml = strFromU8(part.data);
  const w = new RegExp(`xmlns:(\\w+)="${WORD_NS}"`).exec(xml)?.[1] ?? "w";
  // A new part's placeholder paragraph goes, so the new text isn't under an empty line.
  if (fresh) xml = xml.replace(new RegExp(`<${w}:p\\b[\\s\\S]*?</${w}:p>|<${w}:p/>`), "");
  const close = xml.lastIndexOf(`</${w}:${kind === "header" ? "hdr" : "ftr"}>`);
  if (close < 0) return fail("invalid_operation", `the ${kind} is not one the app can extend.`);
  part.data = strToU8(xml.slice(0, close) + paragraphs(w) + xml.slice(close));
  return xml;
}

const textRun = (w: string, text: string, look = "") =>
  text ? `<${w}:r>${look}<${w}:t xml:space="preserve">${escapeXml(text)}</${w}:t></${w}:r>` : "";
const fieldRuns = (w: string, instruction: string, look = "") =>
  `<${w}:r>${look}<${w}:fldChar ${w}:fldCharType="begin"/></${w}:r>` +
  `<${w}:r>${look}<${w}:instrText xml:space="preserve"> ${instruction} </${w}:instrText></${w}:r>` +
  `<${w}:r>${look}<${w}:fldChar ${w}:fldCharType="separate"/></${w}:r>` +
  `<${w}:r>${look}<${w}:t>1</${w}:t></${w}:r>` +
  `<${w}:r>${look}<${w}:fldChar ${w}:fldCharType="end"/></${w}:r>`;
const paragraphXml = (w: string, align: string, body: string) =>
  `<${w}:p><${w}:pPr><${w}:jc ${w}:val="${align}"/></${w}:pPr>${body}</${w}:p>`;

/** A PAGE field, as a complex field or Word's simple one. */
const PAGE_FIELD = /<\w+:instrText[^>]*>\s*PAGE\b|<\w+:fldSimple\b[^>]*\binstr="\s*PAGE\b/;

/**
 * The part's top-level paragraphs as [start, end) offsets. A logo's text box
 * holds paragraphs of its own, so nesting is counted rather than matched.
 */
function paragraphSpans(xml: string, w: string) {
  const spans: Array<[number, number]> = [];
  let depth = 0;
  let start = -1;
  for (const tag of xml.matchAll(new RegExp(`<(/?)${w}:p(?=[\\s/>])[^>]*?(/?)>`, "g"))) {
    const [text, closing, empty] = tag;
    if (!closing && empty) {
      if (depth === 0) spans.push([tag.index, tag.index + text.length]);
    } else if (!closing) {
      if (depth++ === 0) start = tag.index;
    } else if (--depth === 0) spans.push([start, tag.index + text.length]);
  }
  return spans;
}

/** Removes the paragraphs holding page numbers from the default header and footer. */
function removePageNumbers(doc: Docx) {
  for (const kind of ["header", "footer"] as const) {
    const part = pagePart(doc, kind);
    if (!part) continue;
    let xml = strFromU8(part.data);
    if (!PAGE_FIELD.test(xml)) continue;
    const w = new RegExp(`xmlns:(\\w+)="${WORD_NS}"`).exec(xml)?.[1] ?? "w";
    const spans = paragraphSpans(xml, w);
    const numbered = spans.filter(([from, to]) => PAGE_FIELD.test(xml.slice(from, to)));
    for (const [from, to] of numbered.toReversed()) xml = xml.slice(0, from) + xml.slice(to);
    // A header or footer must keep one paragraph.
    if (numbered.length === spans.length) {
      const close = xml.lastIndexOf(`</${w}:${kind === "header" ? "hdr" : "ftr"}>`);
      xml = `${xml.slice(0, close)}<${w}:p/>${xml.slice(close)}`;
    }
    part.data = strToU8(xml);
  }
}

/** Run properties for the numbers, in the order Word reads them. */
function runLook(w: string, look: Extract<WordOperation, { kind: "setPageNumbers" }>) {
  const parts: string[] = [];
  if (look.font)
    parts.push(
      `<${w}:rFonts ${["ascii", "hAnsi", "cs", "eastAsia"].map((name) => `${w}:${name}="${escapeXml(look.font!)}"`).join(" ")}/>`,
    );
  if (look.bold !== undefined)
    parts.push(
      look.bold ? `<${w}:b/><${w}:bCs/>` : `<${w}:b ${w}:val="0"/><${w}:bCs ${w}:val="0"/>`,
    );
  if (look.italic !== undefined)
    parts.push(
      look.italic ? `<${w}:i/><${w}:iCs/>` : `<${w}:i ${w}:val="0"/><${w}:iCs ${w}:val="0"/>`,
    );
  if (look.color) parts.push(`<${w}:color ${w}:val="${look.color}"/>`);
  if (look.size !== undefined) {
    const half = Math.round(look.size * 2);
    parts.push(`<${w}:sz ${w}:val="${half}"/><${w}:szCs ${w}:val="${half}"/>`);
  }
  if (look.underline !== undefined)
    parts.push(`<${w}:u ${w}:val="${look.underline ? "single" : "none"}"/>`);
  return parts.length ? `<${w}:rPr>${parts.join("")}</${w}:rPr>` : "";
}

/** Page numbers as asked: the old ones go first, wherever they were, so this can be called again. */
function setPageNumbers(doc: Docx, operation: Extract<WordOperation, { kind: "setPageNumbers" }>) {
  removePageNumbers(doc);
  sectionSettings(doc, {
    ...(operation.skipFirstPage !== undefined
      ? { firstPageDifferent: operation.skipFirstPage }
      : {}),
    ...(operation.startAt !== undefined ? { start: operation.startAt } : {}),
    ...(operation.numberStyle ? { format: operation.numberStyle } : {}),
  });
  const where = operation.where ?? "footer";
  if (where === "none") return;
  appendToPagePart(doc, where, (w) => {
    const look = runLook(w, operation);
    const runs = (operation.text ?? "{page}")
      .split(/(\{pages?\})/)
      .map((piece) =>
        piece === "{page}"
          ? fieldRuns(w, "PAGE", look)
          : piece === "{pages}"
            ? fieldRuns(w, "NUMPAGES", look)
            : textRun(w, piece, look),
      )
      .join("");
    return paragraphXml(w, operation.align ?? "center", runs);
  });
}

/** Settings of the last section that aren't page geometry. */
function sectionSettings(
  doc: Docx,
  settings: { firstPageDifferent?: boolean; start?: number; format?: string },
) {
  const body = doc.document.body;
  let next = body.sectPr ?? element("sectPr");
  if (settings.firstPageDifferent !== undefined)
    next = withChild(
      next,
      "titlePg",
      settings.firstPageDifferent ? element("titlePg") : null,
      ORDER.sectPr,
    );
  if (settings.start !== undefined || settings.format) {
    const current = childNamed(next, "pgNumType");
    const attrs = Object.fromEntries(
      current?.attrs.map((attr) => [attr.name.local, attr.value]) ?? [],
    );
    if (settings.start !== undefined) attrs.start = String(settings.start);
    if (settings.format) attrs.fmt = settings.format;
    next = withChild(next, "pgNumType", element("pgNumType", attrs), ORDER.sectPr);
  }
  body.sectPr = next;
  orderSection(doc);
}

/** A section's properties in the order Word reads them. */
function orderSection(doc: Docx) {
  const body = doc.document.body;
  if (!body.sectPr) return;
  const order: readonly string[] = ORDER.sectPr;
  const rank = (node: XmlElement["children"][number]) =>
    node.kind === "element" && order.includes(node.name.local)
      ? order.indexOf(node.name.local)
      : order.length;
  body.sectPr = {
    ...body.sectPr,
    children: body.sectPr.children.toSorted((a, b) => rank(a) - rank(b)),
  };
}

/** Word's margin presets, in twips. */
const MARGINS: Record<string, { top: number; side: number }> = {
  normal: { top: 1440, side: 1440 },
  narrow: { top: 720, side: 720 },
  moderate: { top: 1440, side: 1080 },
  wide: { top: 1440, side: 2880 },
};

function pageLayout(doc: Docx, operation: Extract<WordOperation, { kind: "setPageLayout" }>) {
  if (operation.size) setPageSize(doc, operation.size === "A4" ? PAGE_SIZE_A4 : PAGE_SIZE_LETTER);
  if (operation.orientation) setPageOrientation(doc, operation.orientation);
  if (operation.margins) {
    const preset = MARGINS[operation.margins]!;
    setPageMargins(doc, {
      top: preset.top,
      bottom: preset.top,
      left: preset.side,
      right: preset.side,
      header: 708,
      footer: 708,
      gutter: 0,
    });
  }
  if (operation.firstPageDifferent !== undefined)
    sectionSettings(doc, { firstPageDifferent: operation.firstPageDifferent });
  orderSection(doc);
}

type Placed = { before?: number; after?: number; at?: "start" | "end" };

/** Applies one batch; a failing operation names itself and nothing of the batch is saved. */
export function editWordFile(bytes: Uint8Array, rawOperations: unknown) {
  const operations = parseWordOperations(rawOperations, "worker");
  const doc = openWordFile(bytes);
  const body = doc.document.body;
  // Block numbers mean the revision's blocks, whatever this batch did before.
  const original: readonly WmlBlock[] = [...body.blocks];
  // A file may already carry problems Word tolerates; only new ones stop the edit.
  const known = new Set(
    validate(doc)
      .filter((issue) => issue.level === "error")
      .map((issue) => issue.message),
  );
  // Inside the inspected document a number means that block, whatever this call did before;
  // past its end, numbers count on into what the call has added, as a document being written
  // top to bottom is counted.
  const at = (index: number, path: string): WmlBlock => {
    const item = index < original.length ? original[index] : body.blocks[index];
    if (!item)
      return fail(
        "invalid_operation",
        `${path}: there is no block ${index}; the document had ${original.length} when inspected and has ${body.blocks.length} at this point of the call. To add after everything, use at: "end".`,
      );
    if (!body.blocks.includes(item))
      return fail("invalid_operation", `${path}: block ${index} was removed earlier in this call.`);
    return item;
  };
  const tableAt = (index: number, path: string) => {
    const item = at(index, path);
    return item.kind === "table"
      ? item
      : fail("invalid_operation", `${path}: block ${index} is not a table.`);
  };
  /** Moves blocks just appended at the end into their place. */
  const place = (made: readonly WmlBlock[], where: Placed, path: string) => {
    // Taken out first, so a number counting on through this call doesn't count them.
    for (const item of made) body.blocks.splice(body.blocks.indexOf(item), 1);
    const target = where.before ?? where.after;
    const anchor = target === undefined ? null : at(target, path);
    const index =
      anchor !== null
        ? body.blocks.indexOf(anchor) + (where.after !== undefined ? 1 : 0)
        : where.at === "start"
          ? 0
          : body.blocks.length;
    body.blocks.splice(index, 0, ...made);
  };
  const results: Array<Record<string, unknown>> = [];
  const created: Array<{ operation: number; blocks: readonly WmlBlock[] }> = [];
  for (const [index, operation] of operations.entries()) {
    const path = `operations[${index}] ${operation.kind}`;
    try {
      apply(operation, path, index);
    } catch (error) {
      if (error instanceof WordError) throw error;
      fail(
        "invalid_operation",
        `${path}: ${error instanceof Error ? error.message.slice(0, 200) : "failed"}`,
      );
    }
  }

  function apply(operation: WordOperation, path: string, index: number) {
    switch (operation.kind) {
      case "replaceText": {
        const matchCase = operation.matchCase ?? true;
        const escaped = operation.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(escaped, matchCase ? "g" : "gi");
        const count =
          replaceTextEverywhere(doc, pattern, () => operation.replace) +
          inTableCells(doc, () => replaceText(doc, pattern, () => operation.replace));
        if (!count)
          fail(
            "not_found",
            `${path}: "${clip(operation.find, 60)}" was not found; text split by a tracked change or a field can't be matched.`,
          );
        results.push({ operation: index, replaced: count });
        return;
      }
      case "setParagraph": {
        const paragraph = at(operation.block, path);
        if (paragraph.kind !== "paragraph")
          fail("invalid_operation", `${path}: block ${operation.block} is not a paragraph.`);
        const target = paragraph as WmlParagraph;
        if (operation.style) setParagraphStyle(target, styleId(doc, operation.style));
        if (operation.align) setParagraphAlignment(target, ALIGN[operation.align]!);
        if (operation.text !== undefined) {
          const first = target.children.find((child) => child.kind === "run");
          // Inline markup decides bold and italic afresh; the font and colour stay.
          const {
            bold: _bold,
            italic: _italic,
            ...base
          } = first && first.kind === "run" ? getRunFormat(first) : {};
          fill(doc, target, operation.text, base);
        }
        return;
      }
      case "insertParagraphs": {
        const made = build(doc, operation.paragraphs);
        place(made, operation, path);
        created.push({ operation: index, blocks: made });
        return;
      }
      case "insertTable": {
        const table = addTable(doc, operation.rows);
        setTableBorders(table);
        if (operation.headerRow ?? true) {
          setTableRowAsHeader(table.rows[0]!);
          operation.rows[0]!.forEach((text, column) =>
            setTableCellText(table, 0, column, text, { bold: true }),
          );
        }
        place([table], operation, path);
        created.push({ operation: index, blocks: [table] });
        return;
      }
      case "insertPageBreak": {
        const made = appendPageBreak(doc);
        place([made], operation, path);
        created.push({ operation: index, blocks: [made] });
        return;
      }
      case "removeBlocks": {
        const doomed = operation.blocks.map((block) => at(block, path));
        for (const item of new Set(doomed)) body.blocks.splice(body.blocks.indexOf(item), 1);
        return;
      }
      case "setTableCell": {
        const table = tableAt(operation.table, path);
        const row = table.rows[operation.row];
        if (!row)
          return fail("invalid_operation", `${path}: the table has ${table.rows.length} rows.`);
        if (operation.column >= row.cells.length)
          fail("invalid_operation", `${path}: row ${operation.row} has ${row.cells.length} cells.`);
        setTableCellText(table, operation.row, operation.column, operation.text);
        return;
      }
      case "addTableRows": {
        const table = tableAt(operation.table, path);
        const width = table.rows.at(-1)?.cells.length ?? 0;
        if (operation.rows[0]!.length !== width)
          fail(
            "invalid_operation",
            `${path}: the table's last row has ${width} cells; give rows of ${width}.`,
          );
        for (const row of operation.rows) appendTableRow(table, row);
        return;
      }
      case "removeTableRows": {
        const table = tableAt(operation.table, path);
        const rows = [...new Set(operation.rows)].toSorted((a, b) => b - a);
        if (rows[0]! >= table.rows.length)
          fail("invalid_operation", `${path}: the table has ${table.rows.length} rows.`);
        if (rows.length >= table.rows.length)
          fail("invalid_operation", `${path}: remove the table with removeBlocks instead.`);
        for (const row of rows) removeTableRow(table, row);
        return;
      }
      case "insertImage": {
        const bytes: unknown = operation.imageRef;
        if (!(bytes instanceof Uint8Array))
          return fail("invalid_operation", `${path}: the image was not resolved.`);
        const picture = pictureOf(bytes);
        if (!picture || !picture.width || !picture.height)
          return fail("invalid_operation", `${path}: the image is not a PNG or JPEG picture.`);
        // Its own size at 96 dpi, capped at the text width unless a width was asked for.
        const width = operation.width ?? Math.min(TEXT_WIDTH_CM, (picture.width * 2.54) / 96);
        const widthEmu = Math.round(width * EMU_PER_CM);
        const heightEmu = Math.round((widthEmu * picture.height) / picture.width);
        const paragraph = appendParagraph(doc, "");
        paragraph.children.length = 0;
        insertImageInto(doc, paragraph, bytes, {
          widthEmu,
          heightEmu,
          contentType: picture.mediaType,
          ...(operation.altText ? { altText: operation.altText } : {}),
        });
        setParagraphAlignment(paragraph, operation.align ?? "center");
        const made: WmlParagraph[] = [paragraph];
        if (operation.caption) {
          const caption = appendParagraph(doc, "");
          const captionStyle = findStyleIdByName(doc, "caption");
          if (captionStyle) setParagraphStyle(caption, captionStyle);
          fill(doc, caption, operation.caption, captionStyle ? {} : { italic: true });
          setParagraphAlignment(caption, operation.align ?? "center");
          made.push(caption);
        }
        place(made, operation, path);
        created.push({ operation: index, blocks: made });
        return;
      }
      case "insertTableOfContents": {
        // Levels are outline levels, so a heading counts by its style, not its look.
        const toc = addTableOfContents(doc, {
          headingLevels: { from: 1, to: operation.levels ?? 3 },
          placeholderText: "Update this table of contents to see its entries.",
        });
        place([toc], operation, path);
        created.push({ operation: index, blocks: [toc] });
        return;
      }
      case "setHeader":
      case "setFooter": {
        const kind = operation.kind === "setHeader" ? "header" : "footer";
        const pageNumber = operation.kind === "setFooter" && (operation.pageNumber ?? false);
        if ((operation.mode ?? "replace") === "replace") {
          setPageText(doc, kind, operation.text, pageNumber);
          return;
        }
        if (!operation.text && !pageNumber)
          fail("invalid_operation", `${path}: give text to append.`);
        appendToPagePart(doc, kind, (w) =>
          paragraphXml(
            w,
            "center",
            textRun(w, operation.text && pageNumber ? `${operation.text} ` : operation.text) +
              (pageNumber ? fieldRuns(w, "PAGE") : ""),
          ),
        );
        return;
      }
      case "setPageNumbers":
        setPageNumbers(doc, operation);
        return;
      case "setStyle":
        restyle(doc, operation);
        return;
      case "addFootnote": {
        const paragraph = at(operation.block, path);
        if (paragraph.kind !== "paragraph")
          return fail("invalid_operation", `${path}: block ${operation.block} is not a paragraph.`);
        addFootnote(doc, paragraph, operation.text);
        return;
      }
      case "setTitle":
        setTitle(doc, operation.title);
        return;
      case "setPageLayout":
        pageLayout(doc, operation);
        return;
    }
  }

  closeBody(doc);
  if (body.blocks.length > WORD_LIMITS.blocks)
    fail("limit", `A Word file can have at most ${WORD_LIMITS.blocks} paragraphs and tables.`);
  const problems = validate(doc).filter(
    (issue) => issue.level === "error" && !known.has(issue.message),
  );
  if (problems.length)
    fail(
      "invalid_operation",
      `The edit would leave a document Word can't open: ${clip(problems[0]!.message, 200)}`,
    );
  const output = save(doc);
  // Where new content landed, so the next call can address it.
  for (const entry of created) {
    const numbers = entry.blocks
      .map((item) => body.blocks.indexOf(item))
      .filter((item) => item >= 0);
    results.push({
      operation: entry.operation,
      blocks: numbers.length > 1 ? `${numbers[0]}-${numbers.at(-1)}` : String(numbers[0]),
    });
  }
  return {
    bytes: output,
    blockCount: body.blocks.length,
    results: results.toSorted((a, b) => Number(a.operation) - Number(b.operation)),
    operations: operations.map((operation) => operation.kind),
  };
}
export type WordEdit = ReturnType<typeof editWordFile>;
export type WordInspection = ReturnType<typeof inspectWordFile>;
