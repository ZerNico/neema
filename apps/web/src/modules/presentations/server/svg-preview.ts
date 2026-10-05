import { Resvg } from "@resvg/resvg-js";
import { PRESENTATION_LIMITS } from "../limits.ts";
import { localName, parseXml, type XmlElement } from "./package-xml.ts";

type Cost = { elements: number; paint: number; geometry: number };

// The worker timeout cannot interrupt resvg's native code, so drawing is budgeted
// first. A unit is one translucent fill across a 1280×1280 preview (2.4 ms); a
// layer measured about 5 units, a filter primitive up to 40. Painting scales
// with pixels, path data does not.
const fullPreview = 1280 * 1280;
const weights = { layer: 4, filter: 40, geometryChars: 50_000 };
const pictureBudget = { bytes: 2 * 1024 * 1024, elements: 10_000, units: 2_000 };
export const svgRenderBudget = () => ({ units: 4_000, pixels: 16_000_000 });
export type SvgRenderBudget = ReturnType<typeof svgRenderBudget>;
const layered = /(?:^|;)\s*(?:opacity|mask|clip-path|filter)\s*:/;
// Primitives whose cost grows with pixels alone; convolution, morphology,
// turbulence and lighting also grow with their own parameters.
const cheapFilters = new Set([
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feComposite",
  "feDropShadow",
  "feFlood",
  "feFuncA",
  "feFuncB",
  "feFuncG",
  "feFuncR",
  "feGaussianBlur",
  "feMerge",
  "feMergeNode",
  "feOffset",
]);
const decoder = new TextDecoder("utf-8", { fatal: true });

/** The ids an element points at, through `url(#…)` or a local href. */
const references = (node: XmlElement) =>
  [...node.attributes].flatMap((attribute) => [
    ...[...attribute.value.matchAll(/url\(\s*['"]?#([^'")\s]+)/g)].map((match) => match[1]!),
    ...(attribute.name.split(":").at(-1) === "href" ? [attribute.value.trim().slice(1)] : []),
  ]);

/** What drawing an SVG costs once `use` and `url(#…)` references expand, or null when it can't be bounded. */
export function drawCost(data: Uint8Array): Cost | null {
  if (data.length > pictureBudget.bytes) return null;
  let text: string;
  try {
    text = decoder.decode(data);
  } catch {
    return null;
  }
  // resvg expands entities and this parser does not, so their counts would disagree.
  if (/<!(?:DOCTYPE|ENTITY)/i.test(text)) return null;
  const root = parseXml(text).documentElement;
  if (!root || localName(root) !== "svg") return null;
  const all = [root, ...root.querySelectorAll("*")];
  if (all.length > pictureBudget.elements) return null;
  const ids = new Map<string, XmlElement[]>();
  let sheetLayer = 0;
  for (const node of all) {
    const name = localName(node);
    // Markers repeat at every vertex, which references alone don't count.
    if (name === "image" || name === "foreignObject" || name === "marker") return null;
    if (name.startsWith("fe") && !cheapFilters.has(name)) return null;
    if (name === "style") {
      const sheet = node.textContent ?? "";
      // A class rule can apply an effect or a paint server to every element,
      // which references counted per element cannot bound.
      if (/(?:filter|mask|clip-path)\s*:|url\(/i.test(sheet)) return null;
      if (/opacity/.test(sheet)) sheetLayer = weights.layer;
    }
    for (const attribute of node.attributes)
      if (attribute.name.split(":").at(-1) === "href" && !attribute.value.trim().startsWith("#"))
        return null;
    const id = node.getAttribute("id");
    if (id) ids.set(id, [...(ids.get(id) ?? []), node]);
  }
  const known = new Map<XmlElement, Cost>();
  const active = new Set<XmlElement>();
  const expand = (node: XmlElement, depth: number): Cost | null => {
    const cached = known.get(node);
    if (cached) return cached;
    if (active.has(node) || depth > 256) return null;
    active.add(node);
    const attributes = [...node.attributes];
    const layer = attributes.some(
      (attribute) =>
        ["opacity", "mask", "clip-path", "filter"].includes(attribute.name) ||
        (attribute.name === "style" && layered.test(attribute.value)),
    );
    const total = {
      elements: 1,
      paint:
        1 +
        sheetLayer +
        (layer ? weights.layer : 0) +
        (localName(node).startsWith("fe") ? weights.filter : 0),
      geometry:
        attributes.reduce((sum, attribute) => sum + attribute.value.length, 0) /
        weights.geometryChars,
    };
    // Duplicate IDs are all charged, since which one resvg resolves is not ours to guess.
    for (const part of [...node.children, ...references(node).flatMap((id) => ids.get(id) ?? [])]) {
      const cost = expand(part, depth + 1);
      if (!cost) return null;
      total.elements += cost.elements;
      total.paint += cost.paint;
      total.geometry += cost.geometry;
    }
    active.delete(node);
    known.set(node, total);
    return total;
  };
  const cost = expand(root, 0);
  return cost && cost.elements <= pictureBudget.elements ? cost : null;
}

type Fonts = { readonly files: readonly string[]; readonly family: string };

/**
 * A PNG of the artwork within what is left of `budget`, or null. Text gets the
 * renderer's bundled faces: without system fonts resvg would drop it silently.
 */
export function rasterizeSvg(data: Uint8Array, budget: SvgRenderBudget, fonts: Fonts) {
  const cost = drawCost(data);
  if (!cost) return null;
  try {
    const source = Buffer.from(data);
    const options = {
      font: /<(?:[\w.-]+:)?text\b/.test(source.toString("utf8"))
        ? { loadSystemFonts: false, fontFiles: [...fonts.files], defaultFontFamily: fonts.family }
        : { loadSystemFonts: false },
    };
    const original = new Resvg(source, options);
    if (original.imagesToResolve().length || !original.width || !original.height) return null;
    if (original.width > 4096 || original.height > 4096) return null;
    const width = Math.min(1280, Math.max(256, Math.ceil(original.width * 2)));
    const height = Math.ceil((width * original.height) / original.width);
    const pixels = width * height;
    const units = (cost.paint * pixels) / fullPreview + cost.geometry;
    if (height > 2048 || pixels > PRESENTATION_LIMITS.renderPixels || pixels > budget.pixels)
      return null;
    if (units > pictureBudget.units || units > budget.units) return null;
    const png = new Resvg(source, { ...options, fitTo: { mode: "width", value: width } })
      .render()
      .asPng();
    if (png.length > PRESENTATION_LIMITS.imageBytes) return null;
    budget.units -= units;
    budget.pixels -= pixels;
    return new Uint8Array(png);
  } catch {
    return null;
  }
}
