import { strFromU8 } from "fflate";
import type { PackageParts } from "../../office/server/package.ts";
import type { ConditionalRule, ConditionalStyle, Threshold } from "@chat/sheet/conditional";
import type { ConditionalFormattingRule } from "@office-kit/xlsx/worksheet";

/**
 * Conditional formats as Excel files keep them, read for a preview to draw.
 * The library does not read a rule's differential format, so a file's
 * highlight styles are read from its stylesheet's XML.
 */

const COMPARE: Record<Extract<ConditionalRule, { kind: "compare" }>["op"], string> = {
  greater: "greaterThan",
  greaterOrEqual: "greaterThanOrEqual",
  less: "lessThan",
  lessOrEqual: "lessThanOrEqual",
  equal: "equal",
  notEqual: "notEqual",
  between: "between",
  notBetween: "notBetween",
};
const TEXT: Record<Extract<ConditionalRule, { kind: "text" }>["op"], string> = {
  contains: "containsText",
  notContains: "notContainsText",
  beginsWith: "beginsWith",
  endsWith: "endsWith",
};

/** A colour attribute of a tag in a part of a style, as #RRGGBB's ARGB. */
const rgb = (part: string, tag: string) =>
  new RegExp(`<${tag}\\b[^>]*\\brgb="([0-9A-Fa-f]{8})"`).exec(part)?.[1];

/** The workbook's differential formats, read from its stylesheet as highlight styles. */
export function fileHighlightStyles(files: PackageParts): ConditionalStyle[] {
  const xml = files["xl/styles.xml"];
  if (!xml) return [];
  const dxfs = /<dxfs\b[^>]*>([\s\S]*?)<\/dxfs>/.exec(strFromU8(xml))?.[1] ?? "";
  return [...dxfs.matchAll(/<dxf>([\s\S]*?)<\/dxf>/g)].map(([, body = ""]) => {
    const font = /<font>([\s\S]*?)<\/font>/.exec(body)?.[1] ?? "";
    const fill = /<fill>([\s\S]*?)<\/fill>/.exec(body)?.[1] ?? "";
    const fontColor = rgb(font, "color");
    // Excel writes a highlight's fill as its background colour; others as the pattern's.
    const fillColor = rgb(fill, "bgColor") ?? rgb(fill, "fgColor");
    return {
      ...(fontColor ? { fontColor: `#${fontColor.slice(2).toUpperCase()}` } : {}),
      ...(fillColor ? { fill: `#${fillColor.slice(2).toUpperCase()}` } : {}),
      ...(/<b\b(?![^>]*val="0")/.test(font) ? { bold: true } : {}),
      ...(/<i\b(?![^>]*val="0")/.test(font) ? { italic: true } : {}),
    };
  });
}

/** A rule's formula as the operand it names: a number, quoted text, or null. */
const value = (formula: string | undefined): number | string | null => {
  if (formula === undefined) return null;
  const text = /^"(.*)"$/.exec(formula)?.[1];
  if (text !== undefined) return text.replace(/""/g, '"');
  const number = Number(formula);
  return Number.isFinite(number) ? number : null;
};

/**
 * A scale's or bar's stops as the rule wrote them, or null when one is a kind
 * the grid cannot place (a formula), so the rule is not drawn wrong.
 */
const thresholds = (inner: string): Threshold[] | null => {
  const stops: Threshold[] = [];
  for (const [tag] of inner.matchAll(/<(?:[\w.-]+:)?cfvo\b[^>]*>/g)) {
    const type = /\btype="([^"]+)"/.exec(tag)?.[1];
    const number = Number(/\bval="([^"]*)"/.exec(tag)?.[1]);
    if (type === "min" || type === "max") stops.push({ type });
    else if (
      (type === "num" || type === "percent" || type === "percentile") &&
      Number.isFinite(number)
    )
      stops.push({ type: type === "num" ? "number" : type, value: number });
    else return null;
  }
  return stops;
};

/** A rule Excel wrote, as the grid draws it; null for kinds it does not (icons, formulas, dates). */
export function readConditional(
  rule: ConditionalFormattingRule,
  styles: readonly ConditionalStyle[],
): ConditionalRule | null {
  const style = (rule.dxfId === undefined ? undefined : styles[rule.dxfId]) ?? {};
  const colors = [...(rule.innerXml ?? "").matchAll(/<color\b[^>]*\brgb="([0-9A-Fa-f]{8})"/g)].map(
    ([, hex = ""]) => `#${hex.slice(2).toUpperCase()}`,
  );
  switch (rule.type) {
    case "cellIs": {
      const op = Object.entries(COMPARE).find(([, name]) => name === rule.operator)?.[0];
      const values = rule.formulas.map(value);
      if (!op || !values.length || values.some((each) => each === null)) return null;
      return {
        kind: "compare",
        op: op as keyof typeof COMPARE,
        values: (values.length > 1 ? [values[0], values[1]] : [values[0]]) as
          | [number | string]
          | [number | string, number | string],
        style,
      };
    }
    case "containsText":
    case "notContainsText":
    case "beginsWith":
    case "endsWith": {
      const op = Object.entries(TEXT).find(([, type]) => type === rule.type)?.[0];
      return op && rule.text !== undefined
        ? { kind: "text", op: op as keyof typeof TEXT, text: rule.text, style }
        : null;
    }
    case "top10":
      return {
        kind: "top",
        count: rule.rank ?? 10,
        ...(rule.percent ? { percent: true } : {}),
        ...(rule.bottom ? { bottom: true } : {}),
        style,
      };
    case "aboveAverage":
      return { kind: "average", ...(rule.aboveAverage === false ? { below: true } : {}), style };
    case "duplicateValues":
      return { kind: "duplicate", style };
    case "uniqueValues":
      return { kind: "duplicate", unique: true, style };
    case "containsBlanks":
      return { kind: "blank", style };
    case "notContainsBlanks":
      return { kind: "blank", not: true, style };
    case "colorScale": {
      const stops = thresholds(rule.innerXml ?? "");
      return (colors.length === 2 || colors.length === 3) && stops?.length === colors.length
        ? { kind: "scale", colors: colors as [string, string] | [string, string, string], stops }
        : null;
    }
    case "dataBar": {
      const stops = thresholds(rule.innerXml ?? "");
      return colors[0] && stops?.length === 2
        ? { kind: "bar", color: colors[0], stops: [stops[0]!, stops[1]!] }
        : null;
    }
    default:
      return null;
  }
}
