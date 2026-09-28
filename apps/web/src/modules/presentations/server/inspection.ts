import {
  getGroupChildren,
  getPresentationFonts,
  getPresentationTheme,
  getShapeBoundsResolved,
  getShapeChartSpec,
  getShapeId,
  getShapeKind,
  getShapeName,
  getShapePlaceholderIdx,
  getShapePlaceholderType,
  getShapeText,
  getSlideLayout,
  getSlideLayoutName,
  getSlideLayoutPartName,
  getSlideLayoutPlaceholders,
  getSlideLayouts,
  getSlideMasterPartNames,
  getSlideNotes,
  getSlidePartName,
  getSlides,
  getSlideShapes,
  getSlideSize,
  getTableCell,
  getTableCellText,
  getTableDimensions,
  isChartShape,
  isShapePlaceholder,
  isTableShape,
} from "@office-kit/pptx";
import { INSPECT_LIMITS, PRESENTATION_LIMITS } from "../limits.ts";
import { THEME_COLORS } from "../operations.ts";
import { openPackage, relatedPart, type Deck, type Package } from "./package.ts";
import { fail, partId, rootAttribute, toPart } from "./package-xml.ts";
import { canonicalPlaceholderNames, templatePart, templateShapes } from "./template-edits.ts";

type Slide = ReturnType<typeof getSlides>[number];
type Shape = ReturnType<typeof getSlideShapes>[number];

/** What an inspection covers beyond every slide's identity and layout. */
export interface InspectScope {
  /** Slides to summarize: every one, a page of `INSPECT_LIMITS.pageSlides` by position, or these IDs. */
  readonly slides?: "all" | { readonly page: number } | { readonly ids: readonly number[] };
  /** List the summarized slides' shapes in full. */
  readonly shapes?: boolean;
  /** List template candidates of the summarized slides' layouts and masters. */
  readonly owners?: boolean;
  /** The layout catalog, masters and theme. */
  readonly catalog?: boolean;
  readonly templateId?: string;
}

const points = (value: number) => Math.round((value / 12700) * 100) / 100;
const box = (bounds: { x: number; y: number; w: number; h: number } | null) =>
  bounds
    ? {
        x: points(bounds.x),
        y: points(bounds.y),
        width: points(bounds.w),
        height: points(bounds.h),
      }
    : null;
const cellText = (value: string) => value.slice(0, 200);

/** Shapes inside a group, by ID, mapped to the group that holds them. */
export const groupParents = (slide: Slide) =>
  new Map(
    getSlideShapes(slide).flatMap((shape) =>
      getShapeKind(shape) === "group"
        ? getGroupChildren(shape).map((child) => [getShapeId(child), getShapeId(shape)] as const)
        : [],
    ),
  );

export function placeholderNames(slide: Slide) {
  const layout = getSlideLayout(slide);
  return canonicalPlaceholderNames(
    getSlideShapes(slide)
      .filter(isShapePlaceholder)
      .map((shape) => ({
        key: shape,
        type: getShapePlaceholderType(shape) as string | null,
        idx: getShapePlaceholderIdx(shape) ?? 0,
      })),
    layout
      ? getSlideLayoutPlaceholders(layout).map((entry) => ({
          type: entry.type,
          idx: entry.idx ?? 0,
        }))
      : undefined,
  );
}

const kindOf = (shape: Shape) =>
  isTableShape(shape) ? "table" : isChartShape(shape) ? "chart" : getShapeKind(shape);

function describeShape(
  deck: Deck,
  shape: Shape,
  parents: Map<number, number>,
  name: string | null,
) {
  const shapeId = getShapeId(shape);
  const kind = kindOf(shape);
  const text = kind === "shape" ? getShapeText(shape) : "";
  if (text.length > PRESENTATION_LIMITS.textChars) fail("limit", "Shape text exceeds the limit.");
  let detail = {};
  if (kind === "table") {
    const { rows, cols } = getTableDimensions(shape);
    detail = {
      table: {
        rows,
        columns: cols,
        cells: Array.from({ length: Math.min(rows, 12) }, (_row, row) =>
          Array.from({ length: Math.min(cols, 12) }, (_column, column) =>
            cellText(getTableCellText(getTableCell(shape, row, column))),
          ),
        ),
      },
    };
  } else if (kind === "chart") {
    const spec = getShapeChartSpec(shape);
    detail = {
      chart: spec
        ? {
            type: spec.kind,
            title: spec.title ?? null,
            categories: (spec.categories ?? []).slice(0, 30).map((item) => cellText(String(item))),
            series: spec.series.slice(0, 12).map((series) => cellText(series.name)),
          }
        : { type: "unsupported" },
    };
  }
  return {
    shapeId,
    name: getShapeName(shape),
    kind,
    text,
    placeholder: name,
    placeholderType: isShapePlaceholder(shape) ? getShapePlaceholderType(shape) : null,
    editable: kind === "shape",
    ...(parents.has(shapeId) ? { groupId: parents.get(shapeId) } : {}),
    bounds: box(getShapeBoundsResolved(deck, shape)),
    ...detail,
  };
}

const flag = (value: string | null) => (value === null ? null : value !== "0" && value !== "false");

function identity(pkg: Package, slide: Slide) {
  const layout = getSlideLayout(slide);
  const layoutPart = layout ? toPart(getSlideLayoutPartName(layout)) : null;
  const masterPart = layoutPart ? relatedPart(pkg, layoutPart, "slideMaster") : null;
  return {
    slideId: pkg.ids.get(toPart(getSlidePartName(slide)))!,
    layoutId: layoutPart ? partId(layoutPart) : null,
    layoutName: layout ? getSlideLayoutName(layout) : null,
    masterId: masterPart ? partId(masterPart) : null,
  };
}

function summary(pkg: Package, slide: Slide, withShapes: boolean) {
  const shapes = getSlideShapes(slide);
  const names = placeholderNames(slide);
  const layout = getSlideLayout(slide);
  const showMasterSp = (part: string) =>
    pkg.memo(`showMasterSp:${part}`, () => flag(rootAttribute(pkg.text(part), "showMasterSp")));
  const targets = shapes.flatMap((shape) => {
    if (kindOf(shape) !== "shape") return [];
    const text = getShapeText(shape);
    const placeholder = names.get(shape) ?? null;
    return text || placeholder ? [{ shape, text, placeholder }] : [];
  });
  const parents = withShapes ? groupParents(slide) : new Map<number, number>();
  const notes = getSlideNotes(slide);
  return {
    showMasterSp: showMasterSp(toPart(getSlidePartName(slide))),
    layoutShowMasterSp: layout ? showMasterSp(toPart(getSlideLayoutPartName(layout))) : null,
    placeholders: [...names.values()],
    notes: notes ? notes.slice(0, INSPECT_LIMITS.notesChars) : null,
    shapeCount: shapes.length,
    textTargets: targets.slice(0, INSPECT_LIMITS.textTargets).map((target) => ({
      shapeId: getShapeId(target.shape),
      placeholder: target.placeholder,
      text: target.text.slice(0, INSPECT_LIMITS.textTargetChars),
      textTruncated: target.text.length > INSPECT_LIMITS.textTargetChars,
    })),
    textTargetsOmitted: Math.max(0, targets.length - INSPECT_LIMITS.textTargets),
    ...(withShapes
      ? {
          shapes: shapes.map((shape) =>
            describeShape(pkg.deck, shape, parents, names.get(shape) ?? null),
          ),
        }
      : {}),
  };
}
export type SlideIdentity = ReturnType<typeof identity>;
export type SlideSummary = SlideIdentity & ReturnType<typeof summary>;
export const isSummary = (slide: SlideIdentity | SlideSummary): slide is SlideSummary =>
  "placeholders" in slide;

/** A layout or master's own shapes, parsed once per revision. */
const ownedShapes = (pkg: Package, part: string) =>
  pkg.memo(`template:${part}`, () => templateShapes(pkg.doc(part)));

/** Non-placeholder text and pictures the slides' layouts and masters draw, owner by owner. */
export function templateOwners(pkg: Package, slides: readonly SlideIdentity[]) {
  const owners = new Set(slides.flatMap((slide) => [slide.layoutId, slide.masterId]));
  owners.delete(null);
  return [...owners].map((ownerId) => ({
    templateId: ownerId!,
    kind: ownerId!.includes("slideMasters") ? ("master" as const) : ("layout" as const),
    targets: ownedShapes(pkg, toPart(ownerId!)).filter(
      (shape) =>
        !shape.isPlaceholder &&
        (shape.kind === "picture" || (shape.kind === "shape" && !!shape.text)),
    ),
  }));
}

function catalog(deck: Deck) {
  const theme = getPresentationTheme(deck);
  const fonts = getPresentationFonts(deck);
  return {
    layouts: getSlideLayouts(deck).map((layout) => {
      const placeholders = getSlideLayoutPlaceholders(layout);
      const names = canonicalPlaceholderNames(
        placeholders.map((entry) => ({ key: entry, type: entry.type, idx: entry.idx ?? 0 })),
      );
      const targets = placeholders.flatMap((entry) => {
        const name = names.get(entry);
        return name ? [{ entry, name }] : [];
      });
      return {
        layoutId: getSlideLayoutPartName(layout),
        name: getSlideLayoutName(layout),
        textTargets: targets.slice(0, INSPECT_LIMITS.layoutTargets).map(({ entry, name }) => ({
          placeholder: name,
          placeholderIndex: entry.idx ?? 0,
          ambiguous: targets.filter((other) => other.name === name).length > 1,
          bounds: box(entry.bounds),
        })),
        textTargetCount: targets.length,
        textTargetsOmitted: Math.max(0, targets.length - INSPECT_LIMITS.layoutTargets),
      };
    }),
    masters: getSlideMasterPartNames(deck),
    theme: theme
      ? {
          colors: Object.fromEntries(
            Object.entries(theme).filter(([key]) =>
              (THEME_COLORS as readonly string[]).includes(key),
            ),
          ),
          headingFont: fonts?.majorLatin ?? null,
          bodyFont: fonts?.minorLatin ?? null,
        }
      : null,
  };
}

/** Inspects an opened package, computing only what the scope asks for. */
export function inspectPackage(pkg: Package, scope: InspectScope = {}) {
  const slides = getSlides(pkg.deck);
  const size = getSlideSize(pkg.deck);
  const pick = scope.slides;
  const chosen =
    pick === undefined
      ? () => false
      : pick === "all"
        ? () => true
        : "page" in pick
          ? (_id: number, index: number) =>
              Math.floor(index / INSPECT_LIMITS.pageSlides) === pick.page
          : (id: number) => pick.ids.includes(id);
  const entries: (SlideIdentity | SlideSummary)[] = slides.map((slide, index) => {
    const shapes = getSlideShapes(slide);
    if (shapes.length > PRESENTATION_LIMITS.shapesPerSlide)
      fail("limit", "Too many shapes on a slide.");
    if (new Set(shapes.map(getShapeId)).size !== shapes.length)
      fail("invalid_package", "Duplicate shape ID on a slide.");
    const base = identity(pkg, slide);
    return chosen(base.slideId, index)
      ? { ...base, ...summary(pkg, slide, scope.shapes === true) }
      : base;
  });
  const template =
    scope.templateId === undefined ? null : templatePart(pkg.parts, scope.templateId);
  return {
    aspectRatio: size && size.width > 0 && size.height > 0 ? size.width / size.height : null,
    slides: entries,
    templateOwners: scope.owners ? templateOwners(pkg, entries.filter(isSummary)) : [],
    ...(scope.catalog ? catalog(pkg.deck) : {}),
    template: template
      ? {
          templateId: partId(template),
          kind: template.includes("slideMasters") ? ("master" as const) : ("layout" as const),
          shapes: ownedShapes(pkg, template),
        }
      : null,
  };
}
export type Inspection = ReturnType<typeof inspectPackage>;

export async function inspectPresentation(bytes: Uint8Array, scope: InspectScope = {}) {
  return inspectPackage(await openPackage(bytes), scope);
}
