const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
 * The text an XML character-data span stands for: the five predefined entities
 * and numeric references. Anything else, including a reference to a code point
 * that cannot exist, is left as written.
 */
export const decodeXmlText = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity: string) => {
    if (!entity.startsWith("#")) return ENTITIES[entity] ?? match;
    const hex = entity[1] === "x" || entity[1] === "X";
    const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return point <= 0x10ffff ? String.fromCodePoint(point) : match;
  });

/** Escapes text for XML character data; quotes stay literal. */
export const encodeXmlText = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
