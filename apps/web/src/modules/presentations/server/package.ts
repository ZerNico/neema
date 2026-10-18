import {
  getSlidePartName,
  getSlides,
  loadPresentation,
  validatePresentation,
} from "@office-kit/pptx";
import { PRESENTATION_LIMITS } from "../limits.ts";
import { readPresentationArchive } from "./archive.ts";
import {
  checkedXml,
  first,
  fail,
  localName,
  ownerOf,
  parseXml,
  relsOf,
  resolveTarget,
  toPart,
  type Parts,
  type Relation,
  type XmlDocument,
  type XmlElement,
} from "./package-xml.ts";

export type Deck = Awaited<ReturnType<typeof loadPresentation>>;

/**
 * An opened, validated package. Part text and documents are read on first use
 * and kept for the life of this revision, so nothing is parsed twice and parts
 * nobody asks about are only checked, never parsed.
 */
export interface Package {
  readonly bytes: Uint8Array;
  readonly parts: Parts;
  readonly rels: Map<string, Map<string, Relation>>;
  /** Slide part → slideId, in deck order. */
  readonly ids: Map<string, number>;
  readonly deck: Deck;
  text(part: string): string;
  doc(part: string): XmlDocument;
  /** Memoizes per-part results derived from its XML, such as template shapes. */
  memo<T>(key: string, compute: () => T): T;
}

const imageType = /\/image$/;
// Macros and objects are refused by the package reader; these are files a deck has no use for.
const activePart = /\.(?:exe|dll|js|html?|mht|swf)$/i;
const svgPart = /^ppt\/media\/[^/]+\.svg$/i;
const svgOwner =
  /^ppt\/(?:slides\/slide|slideLayouts\/slideLayout|slideMasters\/slideMaster)\d+\.xml$/;

function reader(parts: Parts) {
  const texts = new Map<string, string>();
  const docs = new Map<string, XmlDocument>();
  const memos = new Map<string, unknown>();
  const text = (part: string) => {
    let value = texts.get(part);
    if (value === undefined) {
      value = checkedXml(part, parts.get(part));
      texts.set(part, value);
    }
    return value;
  };
  return {
    text,
    doc: (part: string) => {
      let value = docs.get(part);
      if (!value) {
        value = parseXml(text(part));
        docs.set(part, value);
      }
      return value;
    },
    memo: <T>(key: string, compute: () => T): T => {
      if (!memos.has(key)) memos.set(key, compute());
      return memos.get(key) as T;
    },
  };
}
type Reader = ReturnType<typeof reader>;

function contentTypes(read: Reader) {
  const types = read.doc("[Content_Types].xml").documentElement;
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  for (const item of types.children) {
    const type = item.getAttribute("ContentType") ?? "";
    if (localName(item) === "Default")
      defaults.set(item.getAttribute("Extension")?.toLowerCase() ?? "", type);
    else if (localName(item) === "Override")
      overrides.set(toPart(item.getAttribute("PartName") ?? ""), type);
  }
  return (part: string) =>
    overrides.get(part) ?? defaults.get(part.split(".").at(-1)?.toLowerCase() ?? "");
}

function relationships(parts: Parts, read: Reader) {
  const rels = new Map<string, Map<string, Relation>>();
  for (const name of parts.keys()) {
    if (!name.endsWith(".rels")) continue;
    const source = ownerOf(name);
    if (source && !parts.has(source)) fail("invalid_package", "Relationships have no owning part.");
    const map = new Map<string, Relation>();
    for (const relation of read.doc(name).documentElement.children) {
      if (localName(relation) !== "Relationship") continue;
      const id = relation.getAttribute("Id");
      const target = relation.getAttribute("Target");
      const type = relation.getAttribute("Type");
      if (!id || !target || !type || map.has(id))
        return fail("invalid_package", `Invalid or duplicate relationship in ${name}.`);
      const mode = relation.getAttribute("TargetMode");
      if (mode === "External") {
        if (!type.endsWith("/hyperlink"))
          fail(
            "unsupported_content",
            "Linked media or external rendering dependencies are unsupported.",
          );
        continue;
      }
      if (mode !== null) fail("invalid_package", "Unknown relationship mode.");
      if (/\/(?:audio|video|media|oleObject|control)$/.test(type))
        fail("unsupported_content", "Embedded audio, video and objects are unsupported.");
      const resolved = resolveTarget(source, target);
      if (!parts.has(resolved))
        fail("invalid_package", `Missing relationship target: ${resolved}.`);
      // Every picture lives in the media folder, where the preview's guards look for it.
      if (imageType.test(type) && !resolved.startsWith("ppt/media/"))
        fail("unsupported_content", `Picture ${resolved} lies outside ppt/media.`);
      if (svgPart.test(resolved) && (!imageType.test(type) || !svgOwner.test(source)))
        fail("unsupported_content", `SVG artwork has an unsupported relationship in ${name}.`);
      map.set(id, { target: resolved, type });
    }
    rels.set(name, map);
  }
  return rels;
}

/** SVG is drawn only as PowerPoint embeds it: an `svgBlip` inside a blip whose own embed, if any, is a bitmap. */
function checkSvgEmbeds(read: Reader, rels: Map<string, Map<string, Relation>>) {
  for (const [name, owned] of rels) {
    const svgIds = [...owned].filter(([, relation]) => svgPart.test(relation.target));
    if (!svgIds.length) continue;
    const owner = ownerOf(name);
    const ids = new Set(svgIds.map(([id]) => id));
    const visit = (node: XmlElement, blip: XmlElement | null) => {
      for (const attribute of node.attributes)
        if (attribute.name.startsWith("r:") && ids.has(attribute.value)) {
          if (localName(node) !== "svgBlip" || !blip || attribute.name !== "r:embed")
            return fail(
              "unsupported_content",
              `SVG artwork must be embedded through svgBlip in ${owner}.`,
            );
          const fallback = blip.getAttribute("r:embed");
          const bitmap = fallback ? owned.get(fallback) : undefined;
          if (fallback && (!bitmap || !imageType.test(bitmap.type) || svgPart.test(bitmap.target)))
            fail("unsupported_content", `SVG artwork has an invalid bitmap fallback in ${owner}.`);
        }
      for (const item of node.children) visit(item, localName(item) === "blip" ? item : blip);
    };
    visit(read.doc(owner).documentElement, null);
  }
}

function validate(parts: Parts, read: Reader) {
  if (
    !parts.has("[Content_Types].xml") ||
    !parts.has("ppt/presentation.xml") ||
    !parts.has("_rels/.rels")
  )
    fail("invalid_package", "This is not a PowerPoint presentation package.");
  const typeOf = contentTypes(read);
  for (const name of parts.keys()) {
    if (activePart.test(name))
      fail("unsupported_content", `Unsafe or unsupported package part: ${name}.`);
    if (/\.svg$/i.test(name) && !svgPart.test(name))
      fail("unsupported_content", `Unsafe or unsupported package part: ${name}.`);
    if (name === "[Content_Types].xml") continue;
    const type = typeOf(name);
    if (!type) fail("invalid_package", `No content type for ${name}.`);
    // Kept byte for byte and never served; only the preview draws it, within a budget.
    if (svgPart.test(name) && type !== "image/svg+xml")
      fail("unsupported_content", `SVG artwork ${name} has an unsupported content type.`);
    if (name.endsWith(".xml") || name.endsWith(".rels")) read.text(name);
  }
  const rels = relationships(parts, read);
  checkSvgEmbeds(read, rels);
  return rels;
}

function slideIds(read: Reader, rels: Map<string, Map<string, Relation>>) {
  const lookup = rels.get("ppt/_rels/presentation.xml.rels");
  if (!lookup) return fail("invalid_package", "The presentation has no slide relationships.");
  const list = first(read.doc("ppt/presentation.xml").documentElement, "sldIdLst");
  const slides = list ? [...list.children].filter((item) => localName(item) === "sldId") : [];
  if (slides.length < 1 || slides.length > PRESENTATION_LIMITS.slides)
    fail("limit", `A presentation must contain 1 to ${PRESENTATION_LIMITS.slides} slides.`);
  const ids = new Map<string, number>();
  const seen = new Set<number>();
  for (const item of slides) {
    const id = Number(item.getAttribute("id"));
    const ref = item.getAttribute("r:id");
    const relation = ref ? lookup.get(ref) : undefined;
    if (
      !Number.isSafeInteger(id) ||
      id < 256 ||
      seen.has(id) ||
      !relation?.type.endsWith("/slide") ||
      ids.has(relation.target)
    )
      return fail("invalid_package", "Ambiguous slide identity or relationship.");
    seen.add(id);
    ids.set(relation.target, id);
  }
  return ids;
}

/**
 * Validates a package and loads it. `parts` may be passed when the caller
 * already holds exactly what `bytes` contains, as after its own serialization.
 */
export async function openPackage(bytes: Uint8Array, known?: Parts): Promise<Package> {
  if (bytes.length > PRESENTATION_LIMITS.compressedBytes)
    fail(
      "limit",
      `A PPTX may be at most ${PRESENTATION_LIMITS.compressedBytes / 1024 / 1024} MiB.`,
    );
  const parts = known ?? readPresentationArchive(bytes);
  const read = reader(parts);
  const rels = validate(parts, read);
  const ids = slideIds(read, rels);
  let deck: Deck;
  try {
    deck = await loadPresentation(bytes);
  } catch {
    return fail("invalid_package", "The PowerPoint package cannot be opened.");
  }
  const issue = validatePresentation(deck).find((item) => item.severity === "error");
  if (issue) fail("invalid_package", `Invalid PowerPoint structure: ${issue.message}`);
  const slides = getSlides(deck);
  if (
    slides.length !== ids.size ||
    slides.some((slide) => !ids.has(toPart(getSlidePartName(slide))))
  )
    fail("invalid_package", "PowerPoint slide inventory is inconsistent.");
  return { bytes, parts, rels, ids, deck, ...read };
}

/** Loads a render-only copy the engine built from a validated package, skipping the input gate. */
export async function loadDerived(bytes: Uint8Array) {
  try {
    return await loadPresentation(bytes);
  } catch {
    return fail("processing_error", "The preview copy could not be opened.");
  }
}

export const relationsOf = (pkg: Pick<Package, "rels">, part: string) =>
  pkg.rels.get(relsOf(part)) ?? new Map<string, Relation>();

/** The one related part of this type, such as a layout's master. */
export const relatedPart = (pkg: Pick<Package, "rels">, part: string, type: string) =>
  [...relationsOf(pkg, part).values()].find((relation) => relation.type.endsWith(`/${type}`))
    ?.target ?? null;
