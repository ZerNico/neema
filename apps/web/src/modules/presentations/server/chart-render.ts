import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { PresentationError } from "../errors.ts";
import { createPresentationDraft, editPresentation } from "./adapter.ts";
import type { FontFace } from "./font-file.ts";
import { inspectPresentation } from "./inspection.ts";
import { renderPresentation } from "./render.ts";

/**
 * Draws a workbook's chart with the slide renderer. Excel and PowerPoint store
 * charts in the same format, so the chart's own XML goes onto a blank slide
 * the size of the chart, under the workbook's theme, and the slide is drawn:
 * the colours, fonts, axes and legend are the ones the file declares.
 */
export interface WorkbookChart {
  readonly chart: string;
  readonly theme: string;
  /** The size the chart takes on its sheet, in points. */
  readonly width: number;
  readonly height: number;
}

const EMU_PER_POINT = 12_700;
/** A chart over 30 inches a side is drawn at that size; slides allow 40. */
const MAX_SIDE = 30 * 72;

/**
 * The chart XML as the slide renderer reads it. A literal series name is
 * written the way Excel writes it, which the renderer only reads in its
 * reference form; links to the workbook's data and drawings are dropped, since
 * the values travel in the chart itself.
 */
export const forSlide = (chart: string) =>
  chart
    .replace(
      /<c:tx>(<c:v>[^<]*<\/c:v>)<\/c:tx>/g,
      '<c:tx><c:strRef><c:f></c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0">$1</c:pt></c:strCache></c:strRef></c:tx>',
    )
    .replace(/<c:externalData\b[^>]*\/>|<c:externalData\b[\s\S]*?<\/c:externalData>/g, "")
    .replace(/<c:userShapes\b[^>]*\/>/g, "");

export async function renderWorkbookChart(chart: WorkbookChart, fonts: readonly FontFace[] = []) {
  const scale = Math.min(1, MAX_SIDE / Math.max(chart.width, chart.height));
  const width = Math.max(72, Math.round(chart.width * scale));
  const height = Math.max(72, Math.round(chart.height * scale));
  const draft = await createPresentationDraft();
  const { layouts } = await inspectPresentation(draft, { catalog: true });
  const blank = layouts?.find((layout) => /blank/i.test(layout.name)) ?? layouts?.[0];
  if (!blank) throw new PresentationError("invalid_package", "The chart frame has no layout.");
  // A placeholder chart gives the slide its chart part and relationships;
  // its XML is replaced by the workbook's below.
  const { bytes } = await editPresentation(draft, [
    { kind: "addSlide", layoutId: blank.layoutId, ref: "chart" },
    {
      kind: "addChart",
      slideRef: "chart",
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      chartType: "column",
      categories: ["-"],
      series: [{ name: "-", values: [0] }],
    },
  ]);
  const files = unzipSync(bytes);
  const chartPart = Object.keys(files).find((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name));
  const slidePart = Object.keys(files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .find((name) => strFromU8(files[name]!).includes("<c:chart "));
  if (!chartPart || !slidePart)
    throw new PresentationError("invalid_package", "The chart frame is incomplete.");
  files[chartPart] = strToU8(forSlide(chart.chart));
  const [cx, cy] = [width * EMU_PER_POINT, height * EMU_PER_POINT];
  files["ppt/presentation.xml"] = strToU8(
    strFromU8(files["ppt/presentation.xml"]!).replace(
      /<p:sldSz\b[^>]*\/>/,
      `<p:sldSz cx="${cx}" cy="${cy}"/>`,
    ),
  );
  files[slidePart] = strToU8(
    strFromU8(files[slidePart]!).replace(
      /(<p:graphicFrame\b[\s\S]*?<p:xfrm>)[\s\S]*?(<\/p:xfrm>)/,
      `$1<a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/>$2`,
    ),
  );
  for (const name of Object.keys(files))
    if (/^ppt\/theme\/theme\d+\.xml$/.test(name)) files[name] = strToU8(chart.theme);
  const deck = zipSync(files, { level: 1 });
  const { slides } = await inspectPresentation(deck);
  const [rendered] = await renderPresentation(deck, [slides.at(-1)!.slideId], fonts);
  return rendered!.png;
}
