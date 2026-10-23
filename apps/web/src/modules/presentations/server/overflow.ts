import {
  getShapeId,
  getShapeName,
  getSlidePartName,
  getSlides,
  getSlideShapes,
} from "@office-kit/pptx";
import type { PresentationOperation } from "../operations.ts";
import type { Deck } from "./package.ts";
import { toPart } from "./package-xml.ts";
import type { MeasureText, loadPreview } from "./render.ts";

/**
 * The text audit before and after an edit. Box overruns are measurement
 * advice, not evidence of clipped glyphs in Office.
 */
type Preview = Awaited<ReturnType<typeof loadPreview>>;

// Operations that cannot move, resize, restyle or add text leave the audit as it was.
const textNeutral = new Set<PresentationOperation["kind"]>([
  "moveSlide",
  "removeSlide",
  "setNotes",
  "setBackground",
  "styleShape",
  "arrangeShape",
  "addLine",
  "addImage",
  "replaceImage",
  "addChart",
  "updateChart",
  "removeShape",
]);
export const needsAudit = (operations: readonly PresentationOperation[]) =>
  operations.some((operation) => !textNeutral.has(operation.kind));

// The reporting tolerance; smaller measurements are not a fit guarantee.
const TOLERANCE_PX = 8;
const toPoints = (px: number) => Math.round(px * 0.75);

/**
 * Findings by slide ID, each matched to a shape ID when its name is used once
 * on its slide. A baseline also records, per slide, which shapes could be matched.
 */
export function auditOverflow(
  preview: Preview,
  deck: Deck,
  ids: ReadonlyMap<string, number>,
  measureText: MeasureText,
  baseline: boolean,
) {
  const slides = getSlides(deck).map((slide) => {
    const byName = new Map<string, number[]>();
    for (const shape of getSlideShapes(slide)) {
      const name = getShapeName(shape);
      byName.set(name, [...(byName.get(name) ?? []), getShapeId(shape)]);
    }
    return { slideId: ids.get(toPart(getSlidePartName(slide))), byName };
  });
  const issues = preview
    .auditTextLayout(deck, { measureText, tolerancePx: TOLERANCE_PX })
    .flatMap((issue) => {
      const slide = slides[issue.slideIndex];
      // Only text escaping its box: wraps, split words and small sizes are typography, not overflow.
      if (
        (issue.kind !== "overflow-x" && issue.kind !== "overflow-y") ||
        slide?.slideId === undefined
      )
        return [];
      const named = (issue.shapeName !== null && slide.byName.get(issue.shapeName)) || [];
      return [
        {
          slideId: slide.slideId,
          shapeId: named.length === 1 ? named[0] : undefined,
          shapeName: issue.shapeName,
          direction: issue.kind === "overflow-y" ? ("vertical" as const) : ("horizontal" as const),
          overflowPx: issue.overflowPx,
          approximate: issue.approximate,
        },
      ];
    });
  const identities = baseline
    ? new Map(
        slides.flatMap(({ slideId, byName }) =>
          slideId === undefined
            ? []
            : [
                [
                  slideId,
                  new Map(
                    [...byName.values()].flatMap((shapes) =>
                      shapes.map((id) => [id, shapes.length === 1]),
                    ),
                  ),
                ] as const,
              ],
        ),
      )
    : null;
  return { issues, identities };
}
type Findings = ReturnType<typeof auditOverflow>;

/**
 * Classifies the findings on changed slides against the baseline: `new`,
 * `increased` (by at least the tolerance), `existing`, or `uncompared` when
 * the shape cannot be matched or its slide was created by this batch.
 */
export function compareOverflow(
  before: Findings | null,
  after: Findings | null,
  selectedIds: readonly number[],
  created: ReadonlySet<number>,
) {
  const counts = { new: 0, increased: 0, existing: 0, uncompared: 0 };
  const selected = new Set(selectedIds);
  const previous = new Map(
    (before?.issues ?? []).flatMap((issue) =>
      issue.shapeId === undefined
        ? []
        : [[`${issue.slideId}:${issue.shapeId}:${issue.direction}`, issue]],
    ),
  );
  const issues = (after?.issues ?? [])
    .filter((issue) => selected.has(issue.slideId))
    .map((issue) => {
      const identity = before?.identities?.get(issue.slideId);
      const comparable =
        issue.shapeId !== undefined &&
        !created.has(issue.slideId) &&
        identity !== undefined &&
        identity.get(issue.shapeId) !== false;
      const match = comparable
        ? previous.get(`${issue.slideId}:${issue.shapeId}:${issue.direction}`)
        : undefined;
      const classification = !comparable
        ? ("uncompared" as const)
        : !match
          ? ("new" as const)
          : issue.overflowPx - match.overflowPx >= TOLERANCE_PX
            ? ("increased" as const)
            : ("existing" as const);
      counts[classification]++;
      return {
        slideId: issue.slideId,
        ...(issue.shapeId === undefined ? {} : { shapeId: issue.shapeId }),
        shapeName: issue.shapeName,
        direction: issue.direction,
        byPoints: toPoints(issue.overflowPx),
        beforeByPoints: match ? toPoints(match.overflowPx) : null,
        approximate: issue.approximate,
        classification,
      };
    })
    .toSorted(
      (a, b) =>
        Number(a.classification === "existing") - Number(b.classification === "existing") ||
        b.byPoints - a.byPoints,
    );
  return {
    overflow: issues.slice(0, 12),
    overflowSummary: { total: issues.length, counts, omitted: Math.max(0, issues.length - 12) },
  };
}
