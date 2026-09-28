import { DOMParser } from "linkedom";
import { PresentationError } from "../errors.ts";
import { PRESENTATION_LIMITS } from "../limits.ts";

/**
 * The package-level XML vocabulary every engine module shares. Part names are
 * slash-free here (`ppt/slides/slide1.xml`); only inspection output adds the
 * leading slash, through `partId`.
 */
export type Parts = Map<string, Uint8Array>;
export type Relation = { readonly target: string; readonly type: string };
/** Relationships by owning part, then by relationship ID. External targets are left out. */
export type Relations = ReadonlyMap<string, ReadonlyMap<string, Relation>>;
export type XmlNode = Pick<XmlElement, "children" | "localName">;

export const RELATIONSHIPS_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const RELATIONSHIP_TYPES = `${RELATIONSHIPS_NS}/`;

export const fail = (code: string, message: string): never => {
  throw new PresentationError(code, message);
};

const decoder = new TextDecoder("utf-8", { fatal: true });
export const encoder = new TextEncoder();

/** Office Kit names parts with a leading slash; the engine does not. */
export const toPart = (name: string) => name.replace(/^\//, "");
/** The identity inspection reports for a part, and the only place the slash is added. */
export const partId = (part: string) => `/${part}`;

/**
 * A part's text, refused unless it is bounded UTF-8 without declarations,
 * unknown entity references or a relationships prefix other than `r`, the one
 * every attribute lookup here assumes.
 */
export function checkedXml(part: string, bytes: Uint8Array | undefined) {
  if (!bytes || bytes.length > PRESENTATION_LIMITS.xmlPartBytes)
    return fail("invalid_package", `Missing or oversized XML part: ${part}.`);
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return fail("invalid_package", `Invalid UTF-8 in ${part}.`);
  }
  if (/<!|&(?!amp;|lt;|gt;|quot;|apos;|#(?:[0-9]+|x[0-9a-f]+);)/i.test(text))
    return fail(
      "invalid_package",
      `XML entities, declarations or malformed escapes in ${part} are unsupported.`,
    );
  for (const [, prefix, uri] of text.matchAll(/\bxmlns:([\w.-]+)\s*=\s*["']([^"']*)["']/g))
    if ((prefix === "r") !== (uri === RELATIONSHIPS_NS))
      fail("unsupported_content", `${part} binds relationships to a prefix other than r.`);
  return text;
}

/** The part of the DOM the engine reads; linkedom's own typings leave children untyped. */
export interface XmlElement {
  readonly localName: string;
  readonly children: Iterable<XmlElement>;
  readonly attributes: Iterable<{ readonly name: string; readonly value: string }>;
  readonly textContent: string | null;
  readonly outerHTML: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  querySelectorAll(selector: string): Iterable<XmlElement>;
}
export interface XmlDocument {
  readonly documentElement: XmlElement;
}
export const parseXml = (text: string) =>
  new DOMParser().parseFromString(text, "text/xml") as XmlDocument;

export const localName = (node: Pick<XmlElement, "localName">) => node.localName.split(":").at(-1)!;

/** The first descendant with this local name, in document order, without visiting the rest. */
export function first(node: XmlNode, name: string): XmlElement | undefined {
  for (const child of node.children) {
    if (localName(child) === name) return child;
    const found = first(child, name);
    if (found) return found;
  }
  return undefined;
}
/** Every descendant with this local name, in document order. */
export function all(node: XmlNode, name: string, into: XmlElement[] = []): XmlElement[] {
  for (const child of node.children) {
    if (localName(child) === name) into.push(child);
    all(child, name, into);
  }
  return into;
}
/** A direct child by local name. */
export const child = (node: XmlNode, name: string) =>
  [...node.children].find((item) => localName(item) === name);

/** The value of an attribute on a document's root element, read without parsing the rest. */
export function rootAttribute(text: string, name: string) {
  const root = /<(?![?!])[^>]*>/.exec(text)?.[0] ?? "";
  return new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`).exec(root)?.[2] ?? null;
}

/** The relationships part of a part: `ppt/slides/slide1.xml` → `ppt/slides/_rels/slide1.xml.rels`. */
export const relsOf = (part: string) => part.replace(/(^|\/)([^/]+)$/, "$1_rels/$2.rels");
/** The part a relationships part belongs to; the package root is "". */
export function ownerOf(relsPart: string) {
  if (relsPart === "_rels/.rels") return "";
  const match = /^(.*\/)?_rels\/([^/]+)\.rels$/.exec(relsPart);
  return match
    ? `${match[1] ?? ""}${match[2]}`
    : fail("invalid_package", "Malformed relationship part name.");
}

/** Resolves a relationship target against its source part, refusing anything ambiguous. */
export function resolveTarget(source: string, target: string) {
  if (
    !target ||
    /[\\%?#]/.test(target) ||
    [...target].some((character) => character.charCodeAt(0) < 32) ||
    target.startsWith("//")
  )
    return fail("invalid_package", "Unsafe package relationship target.");
  const stack = target.startsWith("/") ? [] : source.split("/").slice(0, -1);
  for (const segment of target.replace(/^\//, "").split("/")) {
    if (segment === "..") {
      if (stack.length === 0)
        return fail("invalid_package", "Package relationship escapes its root.");
      stack.pop();
    } else if (segment === "." || segment === "")
      return fail("invalid_package", "Ambiguous package relationship target.");
    else stack.push(segment);
  }
  return stack.join("/");
}
/** A relative target from one part to another in the same package. */
export function relativeTarget(source: string, target: string) {
  const from = source.split("/").slice(0, -1);
  const to = target.split("/");
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared++;
  return [...from.slice(shared).map(() => ".."), ...to.slice(shared)].join("/");
}

export const EMPTY_RELATIONSHIPS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';

/** One relationship element; `type` is the last segment of a standard relationship type. */
export const relationshipXml = (prefix: string, id: string, type: string, target: string) =>
  `<${prefix}Relationship Id="${id}" Type="${RELATIONSHIP_TYPES}${type}" Target="${target}"/>`;

/**
 * Inserts elements before a document's closing tag, in the prefix that tag
 * uses. Fails rather than returning the text unchanged when there is none.
 */
export function insertBeforeClose(text: string, tag: string, content: (prefix: string) => string) {
  const closing = new RegExp(`</((?:[\\w.-]+:)?)${tag}\\s*>`);
  const match = closing.exec(text);
  if (!match) return fail("unsupported_content", `Unsupported ${tag} serialization.`);
  return text.slice(0, match.index) + content(match[1]!) + text.slice(match.index);
}
/** Inserts elements right after an element closes, in its prefix; fails when it does not occur. */
export function insertAfterClose(text: string, tag: string, content: (prefix: string) => string) {
  const closing = new RegExp(`</((?:[\\w.-]+:)?)${tag}\\s*>`);
  const match = closing.exec(text);
  if (!match) return fail("unsupported_content", `Unsupported ${tag} serialization.`);
  const end = match.index + match[0].length;
  return text.slice(0, end) + content(match[1]!) + text.slice(end);
}

/** One more than the largest number any pattern match captured. */
export const nextNumber = (texts: Iterable<string>, pattern: RegExp) =>
  Math.max(
    0,
    ...[...texts].flatMap((text) => [...text.matchAll(pattern)].map((match) => Number(match[1]))),
  ) + 1;

/** A relationship ID the relationships part does not use yet. */
export const nextRelationshipId = (relationships: string) =>
  `rId${nextNumber([relationships], /\bId=["']rId(\d+)["']/g)}`;

const shapeElement =
  /<((?:[\w.-]+:)?)(sp|pic|cxnSp|graphicFrame)\b(?:[^>]*[^/>])?>[\s\S]*?<\/\1\2>/g;
/** The one shape element whose own cNvPr carries this ID, as a span of the part's text. */
export function shapeSpan(source: string, shapeId: number) {
  const matches = [...source.matchAll(shapeElement)].filter(
    (match) =>
      /<(?:[\w.-]+:)?cNvPr\b[^>]*\bid=(["'])(\d+)\1/.exec(match[0])?.[2] === String(shapeId),
  );
  return matches.length === 1
    ? { start: matches[0]!.index, text: matches[0]![0], tag: matches[0]![2]! }
    : fail("not_found", `Shape ${shapeId} is missing or ambiguous in this part.`);
}
