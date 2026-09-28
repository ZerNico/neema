import { randomUUID } from "node:crypto";
import {
  all,
  encoder,
  fail,
  insertBeforeClose,
  nextRelationshipId,
  parseXml,
  relationshipXml,
  relativeTarget,
  relsOf,
  shapeSpan,
  type Parts,
  type Relations,
} from "./package-xml.ts";

const unsupported = (message: string): never => fail("unsupported_content", message);
const decode = (parts: Parts, part: string) => {
  const bytes = parts.get(part);
  return bytes ? new TextDecoder().decode(bytes) : unsupported(`Missing ${part}.`);
};

/**
 * The picture element with this shape ID in a slide, layout or master, with
 * the one embedded image it shows. Linked, SVG-backed and ambiguous pictures
 * are refused, since replacing them could not keep the shape's identity.
 */
export function pictureMedia(parts: Parts, rels: Relations, part: string, shapeId: number) {
  const span = shapeSpan(decode(parts, part), shapeId);
  if (span.tag !== "pic") return fail("invalid_operation", `Shape ${shapeId} is not a picture.`);
  const picture = parseXml(span.text).documentElement;
  const blips = all(picture, "blip");
  if (all(picture, "cNvPr").length !== 1 || blips.length !== 1)
    return unsupported("Pictures with multiple image references cannot be isolated.");
  const blip = blips[0]!;
  const embed = blip.getAttribute("r:embed");
  if (blip.hasAttribute("r:link") || !embed)
    return unsupported("Linked or unresolved pictures cannot be replaced.");
  if (all(picture, "svgBlip").length)
    return unsupported(
      "Replacing SVG-backed pictures is not supported; other edits preserve the SVG.",
    );
  if ([...span.text.matchAll(/\br:embed=/g)].length !== 1)
    return unsupported("Ambiguous picture image reference.");
  const relation = rels.get(relsOf(part))?.get(embed);
  if (!relation?.type.endsWith("/image"))
    return unsupported("Picture relationship is missing or externally linked.");
  return { span, embed, media: relation.target };
}

/**
 * Points one picture at a fresh media part through a new relationship. Nothing
 * else changes, so another picture, slide or layout sharing the old part keeps it.
 */
export function copyOnWritePicture(
  original: Parts,
  rels: Relations,
  part: string,
  shapeId: number,
  bytes: Uint8Array,
  format: "png" | "jpg",
): Parts {
  const { span } = pictureMedia(original, rels, part, shapeId);
  const source = decode(original, part);
  const relsName = relsOf(part);
  const relationships = decode(original, relsName);
  const newId = nextRelationshipId(relationships);
  const media = `ppt/media/presentation-${randomUUID()}.${format}`;
  if (original.has(media)) return unsupported("Image part identity collision.");
  const picture = span.text.replace(
    /\br:embed=(['"])[^'"]+\1/,
    (_, quote: string) => `r:embed=${quote}${newId}${quote}`,
  );
  const typesName = "[Content_Types].xml";
  let types = decode(original, typesName);
  if (!new RegExp(`\\bExtension=["']${format}["']`, "i").test(types))
    types = insertBeforeClose(
      types,
      "Types",
      (prefix) =>
        `<${prefix}Default Extension="${format}" ContentType="image/${format === "jpg" ? "jpeg" : "png"}"/>`,
    );
  const parts = new Map(original);
  parts.set(
    part,
    encoder.encode(
      source.slice(0, span.start) + picture + source.slice(span.start + span.text.length),
    ),
  );
  parts.set(
    relsName,
    encoder.encode(
      insertBeforeClose(relationships, "Relationships", (prefix) =>
        relationshipXml(prefix, newId, "image", relativeTarget(part, media)),
      ),
    ),
  );
  parts.set(typesName, encoder.encode(types));
  parts.set(media, bytes);
  return parts;
}
