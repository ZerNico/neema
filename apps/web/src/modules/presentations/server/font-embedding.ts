import { createHash } from "node:crypto";
import { BUNDLED_FONTS } from "../limits.ts";
import { fontFacts, toEot } from "./eot.ts";
import { deckTypefaces } from "./font-usage.ts";
import {
  encoder,
  insertBeforeClose,
  nextRelationshipId,
  relsOf,
  resolveTarget,
  type Parts,
} from "./package-xml.ts";

const PRESENTATION = "ppt/presentation.xml";
const CONTENT_TYPES = "[Content_Types].xml";
const FONT_RELATIONSHIP =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/font";
const RELATIONSHIPS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const STYLES = ["regular", "bold", "italic", "boldItalic"] as const;
type Style = (typeof STYLES)[number];

/**
 * The font parts this app writes. Only these are ever replaced or removed:
 * fonts a deck already embedded, from PowerPoint or anywhere else, are kept
 * byte for byte and their families left alone.
 */
export const OWN_FONT_PART =
  /^ppt\/fonts\/chat-[0-9a-f]{8}-(regular|bold|italic|boldItalic)\.fntdata$/;

export interface EmbeddableFace {
  readonly family: string;
  readonly bold: boolean;
  readonly italic: boolean;
  /** The TrueType file. */
  readonly bytes: Uint8Array;
}

const styleOf = (face: EmbeddableFace): Style =>
  face.bold ? (face.italic ? "boldItalic" : "bold") : face.italic ? "italic" : "regular";

const escapeAttribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

const decoder = new TextDecoder();
const text = (parts: Parts, name: string) => decoder.decode(parts.get(name));

/** The prefix a document binds to a namespace on its root element, or null. */
function prefixFor(xml: string, namespace: string) {
  const root = /<(?![?!])[^>]*>/.exec(xml)?.[0] ?? "";
  for (const [, prefix, uri] of root.matchAll(/\sxmlns:([\w.-]+)\s*=\s*"([^"]*)"/g))
    if (uri === namespace) return prefix!;
  return null;
}

/** Sets attributes on the root element, replacing any it already has, never duplicating one. */
function setRootAttributes(xml: string, attributes: Record<string, string>) {
  const match = /<(?![?!])[^>]*>/.exec(xml);
  if (!match) return xml;
  let root = match[0];
  for (const [name, value] of Object.entries(attributes)) {
    root = root.replace(new RegExp(`\\s${name}\\s*=\\s*(["'])[^"']*\\1`, "g"), "");
    root = root.replace(/(\/?>)$/, ` ${name}="${value}"$1`);
  }
  return xml.slice(0, match.index) + root + xml.slice(match.index + match[0].length);
}

// Elements p:presentation may hold after embeddedFontLst, in schema order.
const AFTER_FONT_LIST = [
  "custShowLst",
  "photoAlbum",
  "custDataLst",
  "kinsoku",
  "defaultTextStyle",
  "modifyVerifier",
  "extLst",
];

/**
 * Embeds the faces a deck's text names into its package: `.fntdata` parts,
 * their relationships, the presentation's font list and the content type.
 * Office families are never embedded, since the faces this app holds for them
 * are metric substitutes. Returns null when the package already says the same.
 */
export function embedFontParts(
  parts: Parts,
  faces: readonly EmbeddableFace[],
): { parts: Parts; changed: string[] } | null {
  const presentation = text(parts, PRESENTATION);
  const relsPart = relsOf(PRESENTATION);
  let relationships = text(parts, relsPart);
  const p = /<(?![?!])([\w.-]+:)?presentation\b/.exec(presentation)?.[1] ?? "";
  const r = prefixFor(presentation, RELATIONSHIPS_NS);
  if (!r) return null;

  // Each relationship of the presentation, by id, with its resolved target.
  const relations = new Map<string, { element: string; target: string; type: string }>();
  for (const [element] of relationships.matchAll(/<(?:[\w.-]+:)?Relationship\b[^>]*\/>/g)) {
    const id = /\sId="([^"]*)"/.exec(element)?.[1];
    const target = /\sTarget="([^"]*)"/.exec(element)?.[1];
    const type = /\sType="([^"]*)"/.exec(element)?.[1] ?? "";
    if (id && target && !/\sTargetMode="External"/.test(element))
      relations.set(id, { element, target: resolveTarget(PRESENTATION, target), type });
  }

  // The deck's current font list: ours are rebuilt, anyone else's are kept.
  const listPattern = new RegExp(`<${p}embeddedFontLst\\b[^>]*>[\\s\\S]*?</${p}embeddedFontLst>`);
  const list = listPattern.exec(presentation)?.[0] ?? "";
  const entryPattern = new RegExp(`<${p}embeddedFont\\b[\\s\\S]*?</${p}embeddedFont>`, "g");
  const foreign: string[] = [];
  const foreignFamilies = new Set<string>();
  const ownIds: string[] = [];
  for (const [entry] of list.matchAll(entryPattern)) {
    const ids = [...entry.matchAll(new RegExp(`\\s${r}:id="([^"]*)"`, "g"))].map((m) => m[1]!);
    if (ids.length && ids.every((id) => OWN_FONT_PART.test(relations.get(id)?.target ?? ""))) {
      ownIds.push(...ids);
      continue;
    }
    foreign.push(entry);
    const typeface = /\stypeface="([^"]*)"/.exec(entry)?.[1];
    if (typeface) foreignFamilies.add(typeface.toLowerCase());
  }

  const office = new Set(BUNDLED_FONTS.map((name) => name.toLowerCase()));
  const used = deckTypefaces(parts);
  const byFamily = new Map<string, Map<Style, EmbeddableFace>>();
  for (const face of faces) {
    const key = face.family.toLowerCase();
    if (!used.has(key) || office.has(key) || foreignFamilies.has(key)) continue;
    const styles = byFamily.get(key) ?? new Map<Style, EmbeddableFace>();
    if (!styles.has(styleOf(face))) styles.set(styleOf(face), face);
    byFamily.set(key, styles);
  }

  const next: Parts = new Map(parts);
  for (const name of parts.keys()) if (OWN_FONT_PART.test(name)) next.delete(name);
  for (const id of ownIds) {
    const element = relations.get(id)?.element;
    if (element) relationships = relationships.replace(element, "");
  }

  const entries: string[] = [];
  for (const styles of byFamily.values()) {
    const first = [...styles.values()][0]!;
    const facts = fontFacts(first.bytes);
    const slots = STYLES.flatMap((style) => {
      const face = styles.get(style);
      if (!face) return [];
      const sha = createHash("sha256").update(face.bytes).digest("hex").slice(0, 8);
      const part = `ppt/fonts/chat-${sha}-${style}.fntdata`;
      next.set(part, toEot(face.bytes));
      const id = nextRelationshipId(relationships);
      relationships = insertBeforeClose(
        relationships,
        "Relationships",
        (prefix) =>
          `<${prefix}Relationship Id="${id}" Type="${FONT_RELATIONSHIP}" Target="fonts/${part.slice("ppt/fonts/".length)}"/>`,
      );
      return [`<${p}${style} ${r}:id="${id}"/>`];
    });
    entries.push(
      `<${p}embeddedFont><${p}font typeface="${escapeAttribute(first.family)}" panose="${facts.panose}" pitchFamily="${facts.fixedPitch ? 49 : 2}" charset="0"/>${slots.join("")}</${p}embeddedFont>`,
    );
  }

  const all = [...foreign, ...entries];
  let xml = list ? presentation.replace(list, "") : presentation;
  if (all.length) {
    const element = `<${p}embeddedFontLst>${all.join("")}</${p}embeddedFontLst>`;
    const before = AFTER_FONT_LIST.map((name) => new RegExp(`<${p}${name}\\b`).exec(xml)).find(
      Boolean,
    );
    xml = before
      ? xml.slice(0, before.index) + element + xml.slice(before.index)
      : insertBeforeClose(xml, "presentation", () => element);
  }
  // Fonts embedded whole, so recipients can edit with them, not a subset.
  if (entries.length)
    xml = setRootAttributes(xml, { embedTrueTypeFonts: "1", saveSubsetFonts: "0" });

  let types = text(parts, CONTENT_TYPES);
  if (entries.length && !/\sExtension="fntdata"/i.test(types))
    types = insertBeforeClose(
      types,
      "Types",
      (prefix) => `<${prefix}Default Extension="fntdata" ContentType="application/x-fontdata"/>`,
    );

  next.set(PRESENTATION, encoder.encode(xml));
  next.set(relsPart, encoder.encode(relationships));
  next.set(CONTENT_TYPES, encoder.encode(types));
  const changed = [...new Set([...parts.keys(), ...next.keys()])].filter((name) => {
    const before = parts.get(name);
    const after = next.get(name);
    return !before || !after || Buffer.compare(Buffer.from(before), Buffer.from(after)) !== 0;
  });
  return changed.length ? { parts: next, changed } : null;
}
