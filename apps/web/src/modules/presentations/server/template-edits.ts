import { decodeXmlText, encodeXmlText } from "../../attachments/xml-text.ts";
import { INSPECT_LIMITS } from "../limits.ts";
import {
  all,
  child,
  encoder,
  fail,
  first,
  localName,
  shapeSpan,
  toPart,
  type Parts,
  type XmlDocument,
  type XmlElement,
} from "./package-xml.ts";

/**
 * Edits to layouts and masters. Office Kit exposes no mutable handles for those
 * parts, so these work on their XML the way picture copy-on-write does: small,
 * targeted string edits that leave every other byte alone, followed by the
 * adapter's usual reopen and preservation check.
 */
const templatePattern = /^ppt\/(?:slideLayouts\/slideLayout|slideMasters\/slideMaster)\d+\.xml$/;
export const isTemplatePart = (part: string) => templatePattern.test(part);

/** A layoutId or masterId as inspection reports them, resolved to its package part. */
export function templatePart(parts: Parts, templateId: string) {
  const part = toPart(templateId);
  return isTemplatePart(part) && parts.has(part)
    ? part
    : fail("not_found", "templateId: use a layoutId from layouts[] or a masterId from masters[].");
}

const body = (type: string | null) => type === null || type === "body" || type === "obj";

/** Layout indices anchor body names even when a slide omits an earlier placeholder. */
export function canonicalPlaceholderNames<T>(
  entries: readonly { key: T; type: string | null; idx: number }[],
  layout: readonly { type: string | null; idx: number | null }[] = entries,
) {
  const order = [
    ...new Set(layout.filter((entry) => body(entry.type)).map((entry) => entry.idx ?? 0)),
  ].toSorted((a, b) => a - b);
  const extra = [
    ...new Set(
      entries
        .filter((entry) => body(entry.type) && !order.includes(entry.idx))
        .map((entry) => entry.idx),
    ),
  ].toSorted((a, b) => a - b);
  const indices = [...order, ...extra];
  return new Map(
    entries.flatMap(({ key, type, idx }) => {
      const position = indices.indexOf(idx);
      const name =
        type === "title" || type === "ctrTitle"
          ? "title"
          : type === "subTitle"
            ? "subtitle"
            : body(type)
              ? position === 0
                ? "body"
                : `body${position + 1}`
              : null;
      return name ? [[key, name] as const] : [];
    }),
  );
}

const shapeKinds = {
  sp: "shape",
  pic: "picture",
  cxnSp: "connector",
  graphicFrame: "graphicFrame",
} as const;
const hiddenFlag = (properties: XmlElement | undefined) =>
  ["1", "true"].includes(properties?.getAttribute("hidden") ?? "");

/** Template-owned shapes in document order; association alone does not establish effective visibility. */
export function templateShapes(doc: XmlDocument) {
  const shapes: {
    shapeId: number;
    name: string;
    kind: (typeof shapeKinds)[keyof typeof shapeKinds];
    isPlaceholder: boolean;
    hidden: boolean;
    ancestorHidden: boolean;
    placeholderType: string | null;
    placeholderIndex: number | null;
    text: string;
  }[] = [];
  const visit = (node: XmlElement, ancestorHidden: boolean) => {
    for (const item of node.children) {
      const tag = localName(item);
      if (tag in shapeKinds) {
        const properties = first(item, "cNvPr");
        const placeholder = first(item, "ph");
        const text = all(item, "p")
          .map((paragraph) =>
            all(paragraph, "t")
              .map((run) => run.textContent ?? "")
              .join(""),
          )
          .join("\n");
        shapes.push({
          shapeId: Number(properties?.getAttribute("id")),
          name: properties?.getAttribute("name") ?? "",
          kind: shapeKinds[tag as keyof typeof shapeKinds],
          isPlaceholder: !!placeholder,
          hidden: hiddenFlag(properties),
          ancestorHidden,
          placeholderType: placeholder?.getAttribute("type") ?? null,
          placeholderIndex: placeholder ? Number(placeholder.getAttribute("idx") ?? 0) : null,
          text: text.slice(0, INSPECT_LIMITS.shapeText),
        });
      } else if (tag === "grpSp") {
        const own = child(item, "nvGrpSpPr");
        visit(item, ancestorHidden || hiddenFlag(own && child(own, "cNvPr")));
      } else visit(item, ancestorHidden);
    }
  };
  visit(doc.documentElement, false);
  const names = canonicalPlaceholderNames(
    shapes
      .filter((shape) => shape.isPlaceholder)
      .map((shape) => ({
        key: shape,
        type: shape.placeholderType,
        idx: shape.placeholderIndex ?? 0,
      })),
  );
  return shapes.map((shape) => ({ ...shape, placeholder: names.get(shape) ?? null }));
}

const text = (parts: Parts, part: string) => new TextDecoder().decode(parts.get(part));

/** Replaces literal text inside single runs, as replaceAll does on slides. */
export function replaceTemplateText(parts: Parts, part: string, find: string, replace: string) {
  let count = 0;
  const updated = text(parts, part).replace(
    /(<(?:[\w.-]+:)?t(?:\s[^>]*)?(?<!\/)>)([^<]*)(<\/(?:[\w.-]+:)?t>)/g,
    (match, open: string, content: string, close: string) => {
      const pieces = decodeXmlText(content).split(find);
      if (pieces.length === 1) return match;
      count += pieces.length - 1;
      return `${open}${encodeXmlText(pieces.join(replace))}${close}`;
    },
  );
  if (count) parts.set(part, encoder.encode(updated));
  return count;
}

export function removeTemplateShape(parts: Parts, part: string, shapeId: number) {
  const source = text(parts, part);
  const span = shapeSpan(source, shapeId);
  parts.set(
    part,
    encoder.encode(source.slice(0, span.start) + source.slice(span.start + span.text.length)),
  );
}

const DRAWINGML = "http://schemas.openxmlformats.org/drawingml/2006/main";
export function setTemplateBackground(parts: Parts, part: string, color: string) {
  const source = text(parts, part);
  const cSld = /<((?:[\w.-]+:)?)cSld\b[^>]*>/.exec(source);
  const drawing = new RegExp(`\\bxmlns:([\\w.-]+)\\s*=\\s*["']${DRAWINGML}["']`).exec(source)?.[1];
  if (!cSld || !drawing)
    return fail("unsupported_content", "This template has no slide body to colour.");
  const [p, a] = [cSld[1]!, `${drawing}:`];
  const background = `<${p}bg><${p}bgPr><${a}solidFill><${a}srgbClr val="${color.replace("#", "")}"/></${a}solidFill><${a}effectLst/></${p}bgPr></${p}bg>`;
  const existing = new RegExp(`<${p}bg>[\\s\\S]*?</${p}bg>`);
  const updated = existing.test(source)
    ? source.replace(existing, background)
    : source.slice(0, cSld.index + cSld[0].length) +
      background +
      source.slice(cSld.index + cSld[0].length);
  parts.set(part, encoder.encode(updated));
}
