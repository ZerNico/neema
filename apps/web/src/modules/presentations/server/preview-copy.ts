import { zipSync } from "fflate";
import { PRESENTATION_LIMITS } from "../limits.ts";
import { drawableRaster } from "./media.ts";
import {
  encoder,
  fail,
  insertBeforeClose,
  relationshipXml,
  relativeTarget,
  relsOf,
  type Parts,
  type Relations,
} from "./package-xml.ts";
import { rasterizeSvg, svgRenderBudget } from "./svg-preview.ts";

type Source = {
  readonly parts: Parts;
  readonly rels: Relations;
  readonly ids: ReadonlyMap<string, number>;
};
type Fonts = Parameters<typeof rasterizeSvg>[2];

const svgPart = /^ppt\/media\/[^/]+\.svg$/i;
const artworkOwner =
  /^ppt\/(?:slides\/slide|slideLayouts\/slideLayout|slideMasters\/slideMaster)\d+\.xml$/;
// Relationships that lead away from what a slide draws: other slides, notes, and
// a master's other layouts.
const unrelated = /\/(?:slide|notesSlide|notesMaster|handoutMaster|comments|commentAuthors)$/;
const decoder = new TextDecoder();

/** Every part a slide may draw from: its layout, master, theme, charts and diagrams. */
function reach(source: Source, slide: string) {
  const seen = new Set<string>();
  const pending = [slide];
  while (pending.length) {
    const part = pending.pop()!;
    if (seen.has(part)) continue;
    seen.add(part);
    for (const relation of source.rels.get(relsOf(part))?.values() ?? []) {
      if (unrelated.test(relation.type)) continue;
      if (relation.type.endsWith("/slideLayout") && part.includes("slideMasters/")) continue;
      pending.push(relation.target);
    }
  }
  return seen;
}

/**
 * A disposable render copy; the deck itself keeps every byte. A picture the
 * renderer must not decode (an unknown or vector format, an oversized bitmap,
 * or more pixels than one preview decodes) shows as the renderer's own
 * placeholder, and an SVG-only picture gains a PNG drawn within budget. The
 * slides that show a placeholder are listed.
 */
export function previewCopy(source: Source, selectedIds: readonly number[], fonts: Fonts) {
  const parts = source.parts;
  const reached = new Map<number, Set<string>>();
  for (const [part, id] of source.ids)
    if (selectedIds.includes(id)) reached.set(id, reach(source, part));
  if (reached.size !== selectedIds.length)
    fail("unsupported_content", "The selected slides have no matching package parts.");

  // Which pictures the renderer may decode, charged against one pixel budget.
  const unsafe = new Set<string>();
  let pixels = PRESENTATION_LIMITS.previewImagePixels;
  const judged = new Set<string>();
  for (const part of new Set([...reached.values()].flatMap((owners) => [...owners])))
    for (const relation of source.rels.get(relsOf(part))?.values() ?? []) {
      const target = relation.target;
      if (!relation.type.endsWith("/image") || svgPart.test(target) || judged.has(target)) continue;
      judged.add(target);
      const raster = drawableRaster(parts.get(target)!);
      const cost = raster ? raster.width * raster.height : Infinity;
      if (cost > pixels) unsafe.add(target);
      else pixels -= cost;
    }

  const output = new Map(parts);
  // Emptied bytes keep any reference the blip rewrite below does not reach from decoding.
  for (const target of unsafe) output.set(target, new Uint8Array(0));
  const drawn = new Map<string, string | null>();
  const skipped = new Set<string>();
  const budget = svgRenderBudget();
  let counter = 0;
  const draw = (target: string) => {
    if (!drawn.has(target)) {
      const png = rasterizeSvg(parts.get(target)!, budget, fonts);
      let name: string | null = null;
      if (png) {
        do name = `ppt/media/preview-svg-${counter++}.png`;
        while (parts.has(name));
        output.set(name, png);
      }
      drawn.set(target, name);
    }
    return drawn.get(target) ?? null;
  };
  const owners = new Set(
    [...reached.values()].flatMap((set) => [...set].filter((part) => artworkOwner.test(part))),
  );
  for (const owner of owners) {
    const relations = source.rels.get(relsOf(owner));
    if (!relations) continue;
    let text = decoder.decode(parts.get(owner));
    const svgCount = [...text.matchAll(/<(?:[\w.-]+:)?svgBlip\b/g)].length;
    const stripped = [...relations].some(([, relation]) => unsafe.has(relation.target));
    if (!svgCount && !stripped) continue;
    let relationships = decoder.decode(parts.get(relsOf(owner)));
    let visited = 0;
    let changed = false;
    // A self-closing blip must end its own match, or it would swallow the next picture's.
    text = text.replace(
      /<((?:[\w.-]+:)?)blip(?=[\s>/])[^>]*?(?:\/>|>[\s\S]*?<\/\1blip>)/g,
      (blip) => {
        let openTag = /^<[^>]*>/.exec(blip)![0];
        let result = blip;
        const embed = /\br:embed=(['"])([^'"]+)\1/.exec(openTag);
        if (embed && unsafe.has(relations.get(embed[2]!)?.target ?? "")) {
          // Without an embed the renderer draws its placeholder, or the SVG below.
          const bare = openTag.replace(embed[0], "").replace(/\s+(\/?>)$/, "$1");
          result = bare + result.slice(openTag.length);
          openTag = bare;
          changed = true;
        }
        const svgBlips = [...result.matchAll(/<(?:[\w.-]+:)?svgBlip\b[^>]*>/g)];
        visited += svgBlips.length;
        if (/\br:embed=/.test(openTag)) return result;
        const svgId = /\br:embed=(['"])([^'"]+)\1/.exec(svgBlips[0]?.[0] ?? "")?.[2];
        const svg = svgId ? relations.get(svgId) : undefined;
        const png = svgBlips.length === 1 && svg ? draw(svg.target) : null;
        if (!png) {
          skipped.add(owner);
          return result;
        }
        let index = 1;
        while (
          relations.has(`rIdPreview${index}`) ||
          relationships.includes(`"rIdPreview${index}"`)
        )
          index++;
        const rid = `rIdPreview${index}`;
        relationships = insertBeforeClose(relationships, "Relationships", (prefix) =>
          relationshipXml(prefix, rid, "image", relativeTarget(owner, png)),
        );
        changed = true;
        const selfClosing = openTag.endsWith("/>");
        const withEmbed = `${openTag.slice(0, selfClosing ? -2 : -1)} r:embed="${rid}"${selfClosing ? "/>" : ">"}`;
        return withEmbed + result.slice(openTag.length);
      },
    );
    // svgBlips outside a blip element, or unsafe pictures referenced some other way, were not reached.
    if (visited !== svgCount) skipped.add(owner);
    for (const [id, relation] of relations)
      if (unsafe.has(relation.target) && new RegExp(`["']${id}["']`).test(text)) skipped.add(owner);
    if (changed) {
      output.set(owner, encoder.encode(text));
      output.set(relsOf(owner), encoder.encode(relationships));
    }
  }
  const placeholders = selectedIds.filter((id) =>
    [...reached.get(id)!].some(
      (part) =>
        skipped.has(part) ||
        (!artworkOwner.test(part) &&
          [...(source.rels.get(relsOf(part))?.values() ?? [])].some((relation) =>
            unsafe.has(relation.target),
          )),
    ),
  );
  if (!unsafe.size && ![...drawn.values()].some(Boolean)) return { bytes: null, placeholders };
  if ([...drawn.values()].some(Boolean)) {
    const types = decoder.decode(parts.get("[Content_Types].xml"));
    if (!/\bExtension=["']png["']/i.test(types))
      output.set(
        "[Content_Types].xml",
        encoder.encode(
          insertBeforeClose(
            types,
            "Types",
            (prefix) => `<${prefix}Default Extension="png" ContentType="image/png"/>`,
          ),
        ),
      );
  }
  // Nothing reads this copy but the renderer, so it is stored uncompressed.
  return { bytes: zipSync(Object.fromEntries(output), { level: 0 }), placeholders };
}
