import {
  addSlide,
  addSlideChart,
  addSlideImage,
  addSlideLine,
  addSlideShape,
  addSlideTable,
  addSlideTextBox,
  bringShapeToFront,
  duplicateSlide,
  getShapeBoundsResolved,
  getShapeId,
  getShapeKind,
  getShapeParagraphCount,
  getShapeRunCount,
  getSlideCharts,
  getSlideLayoutName,
  getSlideLayoutPartName,
  getSlideLayouts,
  getSlidePartName,
  getSlides,
  getSlideShapes,
  getTableCell,
  getTableDimensions,
  getTableStyleFlags,
  insertTableColumn,
  insertTableRow,
  isChartShape,
  isTableShape,
  mergeTableCells,
  moveSlide,
  removeShape,
  removeSlide,
  removeTableColumn,
  removeTableRow,
  replaceTextInSlide,
  savePresentation,
  sendShapeToBack,
  setChartSpec,
  setParagraphAlignment,
  setPresentationFonts,
  setPresentationTheme,
  setShapeAlignment,
  setShapeBounds,
  setShapeRunFormat,
  setShapeTextFormat,
  setSlideBackground,
  setSlideLayout,
  setSlideNotes,
  setTableCellAlignment,
  setTableCellAnchor,
  setTableCellFill,
  setTableCellText,
  setTableCellTextFormat,
  ungroupShapes,
  type ChartSpec,
} from "@office-kit/pptx";
import { zipSync } from "fflate";
import { PRESENTATION_LIMITS } from "../limits.ts";
import type { PresentationOperation } from "../operations.ts";
import { readPresentationArchive } from "./archive.ts";
import {
  alignment,
  chartKinds,
  chartSpec,
  colorOf,
  emuBox,
  hexOf,
  isRound,
  paint,
  styleTable,
  textFormat,
  toEmu,
  writeText,
} from "./content.ts";
import { copyOnWritePicture } from "./image-copy-on-write.ts";
import { groupParents, placeholderNames } from "./inspection.ts";
import { addedImageFormat } from "./media.ts";
import { openPackage, relatedPart, relationsOf, type Package } from "./package.ts";
import { fail, first, parseXml, relsOf, shapeSpan, toPart, type Parts } from "./package-xml.ts";
import { dropNotes, ensureNotesMaster, preserveContentTypes } from "./repair.ts";
import {
  isTemplatePart,
  removeTemplateShape,
  replaceTemplateText,
  setTemplateBackground,
  templatePart,
} from "./template-edits.ts";

type Slide = ReturnType<typeof getSlides>[number];
type Shape = ReturnType<typeof getSlideShapes>[number];

export type Refs = {
  readonly slides: Map<string, number>;
  readonly shapes: Map<string, { slideId: number; shapeId: number }>;
  /** Slides the batch changed, for rendering them afterwards; null means every slide. */
  touched: Set<number> | null;
  /** Slides this batch created, whose part names may repeat a removed slide's. */
  readonly created: Set<number>;
};

/**
 * An open deck that consecutive operations change in memory, saved and checked
 * once. `parts` is the last verified package; `allowed` and `additions` gather
 * what the pending operations may change, so the check stays as strict.
 */
export type Session = Package & {
  readonly allowed: Set<string>;
  readonly additions: RegExp[];
  dirty: boolean;
};

export const startSession = async (bytes: Uint8Array): Promise<Session> => ({
  ...(await openPackage(bytes)),
  allowed: new Set(),
  additions: [],
  dirty: false,
});

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(
    Buffer.from(b.buffer, b.byteOffset, b.byteLength),
  );
function assertPreserved(session: Session, after: Parts) {
  for (const [part, data] of session.parts) {
    if (session.allowed.has(part)) continue;
    const current = after.get(part);
    if (!current) fail("preservation", `Unchanged part was removed: ${part}.`);
    else if (!sameBytes(data, current))
      fail("preservation", `Unchanged part was rewritten: ${part}.`);
  }
  for (const name of after.keys())
    if (!session.parts.has(name) && !session.additions.some((pattern) => pattern.test(name)))
      fail("preservation", `Unexpected new package part: ${name}.`);
}

/** Office Kit's serialization of the in-memory deck, with the content types it would lose. */
async function saved(session: Session) {
  const bytes = await savePresentation(session.deck);
  const parts = readPresentationArchive(bytes);
  return { parts, bytes: preserveContentTypes(session.parts, parts) ? null : bytes };
}
/** Checks a changed package against the last verified one and opens it as the next revision. */
async function verify(session: Session, parts: Parts, bytes: Uint8Array | null): Promise<Session> {
  assertPreserved(session, parts);
  const checked = await openPackage(bytes ?? zipSync(Object.fromEntries(parts)), parts);
  return { ...checked, allowed: new Set(), additions: [], dirty: false };
}

export async function flush(session: Session): Promise<Session> {
  if (!session.dirty) return session;
  const next = await saved(session);
  return verify(session, next.parts, next.bytes);
}

/** These read or rewrite package parts directly, so every earlier change must be saved first. */
export const worksOnParts = (op: PresentationOperation) =>
  op.kind === "replaceImage" ||
  op.kind === "updateChart" ||
  op.kind === "replaceAll" ||
  ("templateId" in op && op.templateId !== undefined);

const packageIndex = [
  "[Content_Types].xml",
  "ppt/presentation.xml",
  "ppt/_rels/presentation.xml.rels",
];
const newSlideParts = /^ppt\/slides\/(?:slide\d+\.xml|_rels\/slide\d+\.xml\.rels)$/;
// Duplicated slides copy their chart and notes parts under "-copyN" names.
const newChartParts =
  /^ppt\/(?:charts\/(?:_rels\/)?chart[\w-]*\.xml(?:\.rels)?|embeddings\/Microsoft_Excel_Worksheet[\w-]*\.xlsx)$/;
const newNotesParts = [
  /^ppt\/notesSlides\/(?:_rels\/)?notesSlide[\w-]*\.xml(?:\.rels)?$/,
  /^ppt\/notesMasters\/(?:_rels\/)?notesMaster\d+\.xml(?:\.rels)?$/,
  /^ppt\/theme\/theme\d+\.xml$/,
];
const newMedia = /^ppt\/media\/[^/]+\.(?:png|jpe?g)$/i;
const replacedMedia = /^ppt\/media\/presentation-[0-9a-f-]+\.(?:png|jpg)$/;

/** The chart part a frame points at, its relationships and the workbook they embed. */
function chartDependencies(pkg: Package, slide: string, shapeId: number) {
  const frame = parseXml(shapeSpan(pkg.text(slide), shapeId).text).documentElement;
  const rid = first(frame, "chart")?.getAttribute("r:id");
  const target = rid ? relationsOf(pkg, slide).get(rid)?.target : undefined;
  if (!target) return fail("unsupported_content", "This chart's data part could not be resolved.");
  return [
    target,
    relsOf(target),
    ...[...relationsOf(pkg, target).values()].map((item) => item.target),
  ];
}
function firstMasterTheme(pkg: Package) {
  const ref = first(pkg.doc("ppt/presentation.xml").documentElement, "sldMasterId")?.getAttribute(
    "r:id",
  );
  const master = ref ? relationsOf(pkg, "ppt/presentation.xml").get(ref)?.target : undefined;
  return (
    (master ? relatedPart(pkg, master, "theme") : null) ??
    fail("unsupported_content", "The deck has no theme to change.")
  );
}

type Target = {
  slideId?: number;
  slideRef?: string;
  shapeId?: number;
  shapeRef?: string;
  placeholder?: string;
};
const boundsMessage = (count: number, index: number) =>
  `index ${index} exceeds the current bounds 0..${count - 1} (${count} slides after preceding operations; indices are zero-based).`;

export async function apply(
  session: Session,
  op: PresentationOperation,
  refs: Refs,
): Promise<Session> {
  const { deck, ids, allowed, additions } = session;
  // A change made to package parts rather than the open deck, and edits to layouts or masters.
  let patched: Parts | null = null;
  let templatePatch: ((next: Parts) => number) | null = null;
  let removedNotes: string | null = null;
  let deckTouched = true;
  // The part a created slide was given; its ID exists only once saved.
  let createdSlide: string | null = null;
  let createdShape: { slide: Slide; shape: Shape } | null = null;
  const slidePart = (slide: Slide) => toPart(getSlidePartName(slide));
  const idOf = (slide: Slide) => ids.get(slidePart(slide))!;
  const templateOf = (templateId: string) => {
    refs.touched = null;
    const part = templatePart(session.parts, templateId);
    allowed.add(part);
    return part;
  };
  const templateShapeId = (target: { shapeId?: number }) =>
    target.shapeId ??
    fail(
      "invalid_operation",
      "A template shape is addressed by shapeId from inspect's template.shapes.",
    );
  const slideOf = (target: Target) => {
    const id = target.slideRef !== undefined ? refs.slides.get(target.slideRef)! : target.slideId!;
    const slide =
      getSlides(deck).find((item) => idOf(item) === id) ??
      fail(
        "not_found",
        `Slide ${id} does not exist in this revision; use slides[].slideId from the latest result.`,
      );
    refs.touched?.add(id);
    return slide;
  };
  const touch = (slide: Slide) => {
    allowed.add(slidePart(slide));
    return slide;
  };
  const layoutOf = (value: string) => {
    const layouts = getSlideLayouts(deck);
    const byId = layouts.find((layout) => toPart(getSlideLayoutPartName(layout)) === toPart(value));
    if (byId) return byId;
    const byName = layouts.filter(
      (layout) => getSlideLayoutName(layout)?.toLowerCase() === value.toLowerCase(),
    );
    if (byName.length === 1) return byName[0]!;
    // Templates with several masters repeat names; saying "no match" sent
    // models guessing at a name that did exist.
    if (byName.length > 1)
      return fail(
        "invalid_operation",
        `Layout name "${value.slice(0, 100)}" matches ${byName.length} layouts; pass one layoutId: ${byName
          .slice(0, 12)
          .map((layout) => getSlideLayoutPartName(layout))
          .join(", ")}.`,
      );
    return fail(
      "not_found",
      `No layout matches "${value.slice(0, 100)}"; inspect the layout catalog and pass an exact layoutId. Available names (first 12): ${layouts
        .slice(0, 12)
        .map((layout) => getSlideLayoutName(layout)?.slice(0, 100))
        .join(", ")}.`,
    );
  };
  const shapeOf = (slide: Slide, target: Target) => {
    if (target.placeholder) {
      const names = placeholderNames(slide);
      const matches = [...names].filter(([, name]) => name === target.placeholder);
      if (matches.length > 1)
        fail(
          "invalid_operation",
          `Placeholder "${target.placeholder}" is ambiguous on slide ${idOf(slide)}; use an exact shapeId from a focused slide inspection. Matching shapeIds: ${matches
            .slice(0, 12)
            .map(([shape]) => getShapeId(shape))
            .join(", ")}.`,
        );
      return (
        matches[0]?.[0] ??
        fail(
          "not_found",
          `This slide has no ${target.placeholder} placeholder (it has: ${[...names.values()].slice(0, 12).join(", ") || "none"}). Use an existing target, addText, or addSlide to instantiate a layout’s placeholders. setSlideLayout preserves existing shapes; it does not create missing placeholders.`,
        )
      );
    }
    let id = target.shapeId!;
    if (target.shapeRef !== undefined) {
      const created = refs.shapes.get(target.shapeRef)!;
      if (created.slideId !== idOf(slide))
        fail("invalid_operation", `shapeRef "${target.shapeRef}" is on slide ${created.slideId}.`);
      id = created.shapeId;
    }
    const matches = getSlideShapes(slide).filter((shape) => getShapeId(shape) === id);
    return matches.length === 1
      ? matches[0]!
      : fail(
          "not_found",
          `Shape ${id} is missing or ambiguous on slide ${idOf(slide)}. Inspect selectedSlideIds: [${idOf(slide)}] and use shapes[].shapeId from that slide, not a layout or master.`,
        );
  };
  /** Geometry of a grouped shape lives in its group's coordinates; move the group instead. */
  const topLevel = (slide: Slide, shape: Shape) =>
    groupParents(slide).has(getShapeId(shape))
      ? fail(
          "unsupported_content",
          `Shape ${getShapeId(shape)} is inside a group; move, reorder or remove the group (its groupId), or ungroup it first.`,
        )
      : shape;
  const textShape = (slide: Slide, target: Target) => {
    const shape = shapeOf(slide, target);
    if (isTableShape(shape)) fail("invalid_operation", "This is a table; use setTableCells.");
    if (isChartShape(shape)) fail("invalid_operation", "This is a chart; use updateChart.");
    if (getShapeKind(shape) !== "shape")
      fail(
        "invalid_operation",
        `This ${getShapeKind(shape)} has no text; target a text shape or placeholder.`,
      );
    return shape;
  };
  const tableOf = (slide: Slide, target: Target) => {
    const shape = shapeOf(slide, target);
    return isTableShape(shape) ? shape : fail("invalid_operation", "This shape is not a table.");
  };
  const notesOf = (slide: Slide) => relatedPart(session, slidePart(slide), "notesSlide");

  switch (op.kind) {
    case "addSlide":
    case "duplicateSlide": {
      if (getSlides(deck).length >= PRESENTATION_LIMITS.slides)
        fail("limit", "Slide limit reached.");
      let created: Slide;
      if (op.kind === "addSlide") created = addSlide(deck, { layout: layoutOf(op.layoutId) });
      else {
        const source = slideOf(op);
        if (
          [...relationsOf(session, slidePart(source)).values()].some((relation) =>
            /\/(?:comments|oleObject|package|audio|video)$/i.test(relation.type),
          )
        )
          fail(
            "unsupported_content",
            "Slides with comments or embedded objects can't be duplicated; add a slide from its layout instead.",
          );
        created = duplicateSlide(deck, source);
      }
      if (op.index !== undefined) {
        const count = getSlides(deck).length;
        if (op.index >= count) fail("invalid_operation", boundsMessage(count, op.index));
        moveSlide(deck, created, op.index);
      }
      createdSlide = slidePart(created);
      packageIndex.forEach((name) => allowed.add(name));
      additions.push(newSlideParts, newChartParts, ...newNotesParts);
      break;
    }
    case "moveSlide": {
      const slide = slideOf(op);
      const count = getSlides(deck).length;
      if (op.index >= count) fail("invalid_operation", boundsMessage(count, op.index));
      moveSlide(deck, slide, op.index);
      allowed.add("ppt/presentation.xml");
      break;
    }
    case "removeSlide": {
      if (getSlides(deck).length === 1) fail("invalid_operation", "Cannot remove the last slide.");
      const slide = slideOf(op);
      allowed.add(slidePart(slide));
      allowed.add(relsOf(slidePart(slide)));
      packageIndex.forEach((name) => allowed.add(name));
      removedNotes = notesOf(slide);
      if (removedNotes) {
        allowed.add(removedNotes);
        allowed.add(relsOf(removedNotes));
      }
      removeSlide(deck, slide);
      break;
    }
    case "setSlideLayout": {
      const slide = slideOf(op);
      setSlideLayout(slide, layoutOf(op.layoutId));
      allowed.add(relsOf(slidePart(slide)));
      break;
    }
    case "setNotes": {
      const slide = slideOf(op);
      setSlideNotes(slide, op.text);
      const notes = notesOf(slide);
      if (notes) allowed.add(notes);
      allowed.add("[Content_Types].xml");
      allowed.add(relsOf(slidePart(slide)));
      additions.push(...newNotesParts);
      break;
    }
    case "setBackground": {
      if (op.templateId === undefined) {
        setSlideBackground(touch(slideOf(op)), colorOf(op.color));
        break;
      }
      const part = templateOf(op.templateId);
      deckTouched = false;
      templatePatch = (next) => {
        setTemplateBackground(next, part, hexOf(deck, op.color));
        return 1;
      };
      break;
    }
    case "setText": {
      const slide = touch(slideOf(op));
      writeText(textShape(slide, op), op);
      break;
    }
    case "formatText": {
      const slide = touch(slideOf(op));
      const shape = textShape(slide, op);
      const format = textFormat(op);
      if (op.paragraph === undefined) {
        if (format) setShapeTextFormat(shape, format);
        if (op.align) setShapeAlignment(shape, alignment(op.align));
        break;
      }
      const count = getShapeParagraphCount(shape);
      if (op.paragraph >= count)
        fail(
          "invalid_operation",
          `paragraph ${op.paragraph} does not exist; this shape has ${count}.`,
        );
      if (format)
        for (let run = 0; run < getShapeRunCount(shape, op.paragraph); run++)
          setShapeRunFormat(shape, op.paragraph, run, format);
      if (op.align) setParagraphAlignment(shape, op.paragraph, alignment(op.align));
      break;
    }
    case "replaceAll": {
      const scoped = op.slideId !== undefined || op.slideRef !== undefined;
      let replaced = 0;
      for (const slide of scoped ? [slideOf(op)] : getSlides(deck)) {
        allowed.add(slidePart(slide));
        replaced += replaceTextInSlide(slide, op.find, op.replace);
      }
      if (!scoped) refs.touched = null;
      const templates =
        op.scope === "everywhere" ? [...session.parts.keys()].filter(isTemplatePart) : [];
      templates.forEach((name) => allowed.add(name));
      templatePatch = (next) =>
        replaced +
        templates.reduce(
          (total, name) => total + replaceTemplateText(next, name, op.find, op.replace),
          0,
        );
      break;
    }
    case "addText": {
      const slide = touch(slideOf(op));
      const shape = addSlideTextBox(slide, { ...emuBox(op), text: op.text ?? "" });
      writeText(shape, op);
      createdShape = { slide, shape };
      break;
    }
    case "addShape": {
      const slide = touch(slideOf(op));
      const shape = addSlideShape(slide, {
        preset: op.shape,
        ...emuBox(op),
        ...(op.text !== undefined ? { text: op.text } : {}),
      });
      paint(shape, op);
      if (op.text !== undefined) writeText(shape, { ...op, text: op.text });
      createdShape = { slide, shape };
      break;
    }
    case "addLine": {
      const slide = touch(slideOf(op));
      const shape = addSlideLine(slide, {
        from: { x: toEmu(op.x1), y: toEmu(op.y1) },
        to: { x: toEmu(op.x2), y: toEmu(op.y2) },
        ...(op.color ? { color: colorOf(op.color) } : {}),
        ...(op.lineWidth !== undefined ? { widthEmu: Math.round(op.lineWidth * 12700) } : {}),
      });
      createdShape = { slide, shape };
      break;
    }
    case "styleShape": {
      const slide = touch(slideOf(op));
      paint(shapeOf(slide, op), op);
      break;
    }
    case "setBounds": {
      const slide = touch(slideOf(op));
      const shape = topLevel(slide, shapeOf(slide, op));
      const current =
        getShapeBoundsResolved(deck, shape) ??
        fail("unsupported_content", "This shape has no resolvable position.");
      setShapeBounds(shape, {
        x: op.x !== undefined ? toEmu(op.x) : current.x,
        y: op.y !== undefined ? toEmu(op.y) : current.y,
        w: op.width !== undefined ? toEmu(op.width) : current.w,
        h: op.height !== undefined ? toEmu(op.height) : current.h,
      });
      break;
    }
    case "arrangeShape": {
      const slide = touch(slideOf(op));
      const shape = topLevel(slide, shapeOf(slide, op));
      if (op.order === "front") bringShapeToFront(shape);
      else sendShapeToBack(shape);
      break;
    }
    case "removeShape": {
      if (op.templateId !== undefined) {
        const part = templateOf(op.templateId);
        const shapeId = templateShapeId(op);
        deckTouched = false;
        templatePatch = (next) => {
          removeTemplateShape(next, part, shapeId);
          return 1;
        };
        break;
      }
      const slide = touch(slideOf(op));
      removeShape(topLevel(slide, shapeOf(slide, op)));
      break;
    }
    case "ungroup": {
      const slide = touch(slideOf(op));
      const group = topLevel(slide, shapeOf(slide, op));
      if (getShapeKind(group) !== "group") fail("invalid_operation", "This shape is not a group.");
      ungroupShapes(group);
      break;
    }
    case "addImage": {
      const slide = touch(slideOf(op));
      addedImageFormat(op.imageRef);
      const shape = addSlideImage(slide, op.imageRef, {
        ...emuBox(op),
        fit: op.fit === "fill" ? "fill" : "contain",
      });
      allowed.add(relsOf(slidePart(slide)));
      allowed.add("[Content_Types].xml");
      additions.push(newMedia);
      createdShape = { slide, shape };
      break;
    }
    case "replaceImage": {
      let part: string;
      let shapeId: number;
      if (op.templateId !== undefined) {
        part = templateOf(op.templateId);
        shapeId = templateShapeId(op);
      } else {
        const slide = slideOf(op);
        const shape = shapeOf(slide, op);
        if (getShapeKind(shape) !== "picture")
          fail("unsupported_content", "Only ungrouped slide-local pictures can be replaced.");
        part = slidePart(slide);
        shapeId = getShapeId(shape);
      }
      patched = copyOnWritePicture(
        session.parts,
        session.rels,
        part,
        shapeId,
        op.imageRef,
        addedImageFormat(op.imageRef),
      );
      allowed.add(part);
      allowed.add(relsOf(part));
      allowed.add("[Content_Types].xml");
      additions.push(replacedMedia);
      break;
    }
    case "addTable": {
      const slide = touch(slideOf(op));
      const shape = addSlideTable(slide, {
        ...emuBox(op),
        rows: op.rows,
        firstRow: op.header ?? true,
        bandRow: op.banded ?? true,
      });
      styleTable(deck, shape, op, op.header ?? true);
      createdShape = { slide, shape };
      break;
    }
    case "setTableCells": {
      const slide = touch(slideOf(op));
      const table = tableOf(slide, op);
      const { rows, cols } = getTableDimensions(table);
      for (const [index, cell] of op.cells.entries()) {
        if (cell.row >= rows || cell.column >= cols)
          fail("invalid_operation", `cells[${index}] is outside the ${rows}×${cols} table.`);
        const target = getTableCell(table, cell.row, cell.column);
        if (cell.text !== undefined) setTableCellText(target, cell.text);
        if (cell.fill) setTableCellFill(target, colorOf(cell.fill));
        const format = textFormat(cell);
        if (format) setTableCellTextFormat(target, format);
        if (cell.align) setTableCellAlignment(target, alignment(cell.align));
        if (cell.verticalAlign)
          setTableCellAnchor(target, cell.verticalAlign as "top" | "center" | "bottom");
      }
      break;
    }
    case "styleTable": {
      const slide = touch(slideOf(op));
      const table = tableOf(slide, op);
      styleTable(deck, table, op, getTableStyleFlags(table).firstRow ?? true);
      break;
    }
    case "mergeTableCells": {
      const slide = touch(slideOf(op));
      const table = tableOf(slide, op);
      const { rows, cols } = getTableDimensions(table);
      if (op.row + op.rowSpan > rows || op.column + op.columnSpan > cols)
        fail("invalid_operation", `The block runs outside the ${rows}×${cols} table.`);
      if (op.rowSpan * op.columnSpan < 2) fail("invalid_operation", "Merge at least two cells.");
      mergeTableCells(
        table,
        { row: op.row, col: op.column, rowSpan: op.rowSpan, colSpan: op.columnSpan },
        { coveredText: "drop" },
      );
      break;
    }
    case "addTableRow": {
      const slide = touch(slideOf(op));
      const table = tableOf(slide, op);
      const { rows, cols } = getTableDimensions(table);
      if (rows >= PRESENTATION_LIMITS.tableRows)
        fail("limit", `Tables are limited to ${PRESENTATION_LIMITS.tableRows} rows.`);
      if (op.index !== undefined && op.index > rows)
        fail("invalid_operation", `index exceeds the ${rows} rows.`);
      if (op.cells && op.cells.length !== cols)
        fail("invalid_operation", `cells must have ${cols} entries, one per column.`);
      insertTableRow(table, op.index ?? rows, op.cells);
      break;
    }
    case "removeTableRow": {
      const slide = touch(slideOf(op));
      const table = tableOf(slide, op);
      const { rows } = getTableDimensions(table);
      if (rows === 1 || op.index >= rows)
        fail("invalid_operation", `Row ${op.index} can't be removed from ${rows} rows.`);
      removeTableRow(table, op.index);
      break;
    }
    case "addTableColumn": {
      const slide = touch(slideOf(op));
      const table = tableOf(slide, op);
      const { cols } = getTableDimensions(table);
      if (cols >= PRESENTATION_LIMITS.tableColumns)
        fail("limit", `Tables are limited to ${PRESENTATION_LIMITS.tableColumns} columns.`);
      if (op.index !== undefined && op.index > cols)
        fail("invalid_operation", `index exceeds the ${cols} columns.`);
      insertTableColumn(table, op.index ?? cols);
      break;
    }
    case "removeTableColumn": {
      const slide = touch(slideOf(op));
      const table = tableOf(slide, op);
      const { cols } = getTableDimensions(table);
      if (cols === 1 || op.index >= cols)
        fail("invalid_operation", `Column ${op.index} can't be removed from ${cols} columns.`);
      removeTableColumn(table, op.index);
      break;
    }
    case "addChart": {
      const slide = touch(slideOf(op));
      const shape = addSlideChart(slide, {
        spec: chartSpec(deck, op, op.chartType),
        ...emuBox(op),
      });
      allowed.add(relsOf(slidePart(slide)));
      allowed.add("[Content_Types].xml");
      additions.push(newChartParts);
      createdShape = { slide, shape };
      break;
    }
    case "updateChart": {
      const slide = slideOf(op);
      const shape = shapeOf(slide, op);
      const chart =
        getSlideCharts(slide).find((item) => getShapeId(item.shape) === getShapeId(shape)) ??
        fail("invalid_operation", "This shape is not a chart.");
      const kind = op.chartType ?? chart.spec?.kind;
      if (!kind || !chartKinds.has(kind))
        return fail(
          "unsupported_content",
          "Give chartType; this chart's current type can't be rewritten.",
        );
      if (isRound(kind) && op.series.length !== 1)
        fail("invalid_operation", `This ${kind} chart takes exactly one series.`);
      // Data is replaced; a title or legend the call leaves out keeps its current value.
      const title = op.title ?? chart.spec?.title;
      const spec = chartSpec(deck, { ...op, ...(title ? { title } : {}) }, kind);
      const previous = chart.spec?.legend;
      const restyled = "legend" in spec ? spec.legend : undefined;
      const legend =
        op.legend === undefined && previous
          ? { ...previous, ...(restyled?.textStyle ? { textStyle: restyled.textStyle } : {}) }
          : restyled;
      setChartSpec(chart, legend ? ({ ...spec, legend } as ChartSpec) : spec);
      chartDependencies(session, slidePart(slide), getShapeId(shape)).forEach((name) =>
        allowed.add(name),
      );
      break;
    }
    case "setTheme": {
      const colors = Object.fromEntries(
        Object.entries(op).filter(([key]) => /^(?:dark|light|accent)\d$/.test(key)),
      );
      if (Object.keys(colors).length) setPresentationTheme(deck, colors);
      if (op.headingFont || op.bodyFont)
        setPresentationFonts(deck, {
          ...(op.headingFont ? { majorLatin: op.headingFont } : {}),
          ...(op.bodyFont ? { minorLatin: op.bodyFont } : {}),
        });
      allowed.add(firstMasterTheme(session));
      refs.touched = null;
      break;
    }
  }

  // A plain in-memory change waits for the next save; anything that rewrites
  // parts, adds a slide (whose ID only exists once saved) or links or drops notes saves now.
  const recordShape = () => {
    if ("ref" in op && op.ref && createdShape)
      refs.shapes.set(op.ref, {
        slideId: idOf(createdShape.slide),
        shapeId: getShapeId(createdShape.shape),
      });
  };
  if (
    !patched &&
    !templatePatch &&
    deckTouched &&
    !createdSlide &&
    !removedNotes &&
    op.kind !== "setNotes"
  ) {
    session.dirty = true;
    recordShape();
    return session;
  }
  const next = patched
    ? { parts: patched, bytes: null }
    : deckTouched
      ? await saved(session)
      : { parts: new Map(session.parts), bytes: null };
  let bytes = next.bytes;
  if (templatePatch) {
    if (!templatePatch(next.parts))
      fail("not_found", "The text to replace was not found in any single run.");
    bytes = null;
  }
  if (op.kind === "setNotes" || op.kind === "duplicateSlide") {
    const changed = ensureNotesMaster(next.parts);
    changed.forEach((name) => allowed.add(name));
    if (changed.length) bytes = null;
  }
  if (removedNotes) {
    dropNotes(next.parts, removedNotes);
    bytes = null;
  }
  const checked = await verify(session, next.parts, bytes);
  if (createdSlide) {
    const id = checked.ids.get(createdSlide);
    if (id !== undefined) {
      refs.touched?.add(id);
      refs.created.add(id);
      if ("ref" in op && op.ref) refs.slides.set(op.ref, id);
    }
  } else recordShape();
  return checked;
}
