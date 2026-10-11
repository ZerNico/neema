import { strFromU8, unzipSync } from "fflate";
import type { ConditionalRule, ConditionalStyle } from "@chat/sheet/model/conditional";
import { addDxf, makeDifferentialStyle, makeFill } from "@office-kit/xlsx/styles";
import type { Workbook } from "@office-kit/xlsx/workbook";
import {
  addConditionalFormatting,
  makeCfRule,
  makeConditionalFormatting,
  type ConditionalFormattingRule,
  type Worksheet,
} from "@office-kit/xlsx/worksheet";

/**
 * Conditional formats as Excel files keep them. Live sheets write theirs
 * with their styles as differential formats, and read them back; the
 * library writes those formats but does not read them, so a file's are
 * read from its stylesheet's XML.
 */

/** A conditional format by A1 range on its sheet. */
export interface FileConditional {
  readonly ref: string;
  readonly rule: ConditionalRule;
}

const argb = (hex: string) => `FF${hex.replace(/^#/, "").toUpperCase()}`;
const escape = (text: string) => text.replace(/"/g, '""');
/** An operand as a rule's formula: a number as it is, text quoted. */
const operand = (value: number | string) =>
  typeof value === "number" ? String(value) : `"${escape(value)}"`;
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
const TEXT: Record<
  Extract<ConditionalRule, { kind: "text" }>["op"],
  { type: string; operator: string }
> = {
  contains: { type: "containsText", operator: "containsText" },
  notContains: { type: "notContainsText", operator: "notContains" },
  beginsWith: { type: "beginsWith", operator: "beginsWith" },
  endsWith: { type: "endsWith", operator: "endsWith" },
};

/** A highlight's style as a differential format, its index in the workbook's list. */
function dxfOf(workbook: Workbook, style: ConditionalStyle) {
  return addDxf(
    workbook.styles,
    makeDifferentialStyle({
      ...(style.fontColor || style.bold || style.italic
        ? {
            font: {
              ...(style.fontColor ? { color: { rgb: argb(style.fontColor) } } : {}),
              ...(style.bold ? { bold: true } : {}),
              ...(style.italic ? { italic: true } : {}),
            },
          }
        : {}),
      // A differential fill's colour is its background colour, as Excel writes one.
      ...(style.fill
        ? { fill: makeFill({ patternType: "solid", bgColor: { rgb: argb(style.fill) } }) }
        : {}),
    }),
  );
}

/** Writes a sheet's conditional formats, the first taking the highest priority. */
export function writeConditionals(
  workbook: Workbook,
  sheet: Worksheet,
  formats: readonly FileConditional[],
) {
  formats.forEach(({ ref, rule }, index) => {
    const priority = index + 1;
    const first = ref.split(":")[0]!;
    let made: ConditionalFormattingRule;
    switch (rule.kind) {
      case "compare":
        made = makeCfRule({
          type: "cellIs",
          priority,
          operator: COMPARE[rule.op],
          formulas: rule.values.map(operand),
          dxfId: dxfOf(workbook, rule.style),
        });
        break;
      case "text": {
        const { type, operator } = TEXT[rule.op];
        const test =
          rule.op === "beginsWith"
            ? `LEFT(${first},LEN("${escape(rule.text)}"))="${escape(rule.text)}"`
            : rule.op === "endsWith"
              ? `RIGHT(${first},LEN("${escape(rule.text)}"))="${escape(rule.text)}"`
              : `${rule.op === "notContains" ? "" : "NOT("}ISERROR(SEARCH("${escape(rule.text)}",${first}))${rule.op === "notContains" ? "" : ")"}`;
        made = makeCfRule({
          type: type as ConditionalFormattingRule["type"],
          priority,
          operator,
          text: rule.text,
          formulas: [test],
          dxfId: dxfOf(workbook, rule.style),
        });
        break;
      }
      case "top":
        made = makeCfRule({
          type: "top10",
          priority,
          rank: rule.count,
          ...(rule.percent ? { percent: true } : {}),
          ...(rule.bottom ? { bottom: true } : {}),
          formulas: [],
          dxfId: dxfOf(workbook, rule.style),
        });
        break;
      case "average":
        made = makeCfRule({
          type: "aboveAverage",
          priority,
          ...(rule.below ? { aboveAverage: false } : {}),
          formulas: [],
          dxfId: dxfOf(workbook, rule.style),
        });
        break;
      case "duplicate":
        made = makeCfRule({
          type: rule.unique ? "uniqueValues" : "duplicateValues",
          priority,
          formulas: [],
          dxfId: dxfOf(workbook, rule.style),
        });
        break;
      case "blank":
        made = makeCfRule({
          type: rule.not ? "notContainsBlanks" : "containsBlanks",
          priority,
          formulas: [`LEN(TRIM(${first}))${rule.not ? ">" : "="}0`],
          dxfId: dxfOf(workbook, rule.style),
        });
        break;
      case "scale": {
        const three = rule.colors.length === 3;
        made = makeCfRule({
          type: "colorScale",
          priority,
          formulas: [],
          innerXml: `<colorScale><cfvo type="min"/>${three ? '<cfvo type="percentile" val="50"/>' : ""}<cfvo type="max"/>${rule.colors.map((color) => `<color rgb="${argb(color)}"/>`).join("")}</colorScale>`,
        });
        break;
      }
      case "bar":
        made = makeCfRule({
          type: "dataBar",
          priority,
          formulas: [],
          innerXml: `<dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="${argb(rule.color)}"/></dataBar>`,
        });
        break;
    }
    addConditionalFormatting(sheet, makeConditionalFormatting({ sqref: ref, rules: [made] }));
  });
}

/** A colour attribute of a tag in a part of a style, as #RRGGBB's ARGB. */
const rgb = (part: string, tag: string) =>
  new RegExp(`<${tag}\\b[^>]*\\brgb="([0-9A-Fa-f]{8})"`).exec(part)?.[1];

/** The workbook's differential formats, read from its stylesheet as highlight styles. */
export function fileHighlightStyles(bytes: Uint8Array): ConditionalStyle[] {
  const xml = unzipSync(bytes, { filter: (file) => file.name === "xl/styles.xml" })[
    "xl/styles.xml"
  ];
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

/** A rule Excel wrote, as a live sheet's; null for kinds it does not draw (icons, formulas, dates). */
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
      const op = Object.entries(TEXT).find(([, each]) => each.type === rule.type)?.[0];
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
    case "colorScale":
      return colors.length === 2 || colors.length === 3
        ? { kind: "scale", colors: colors as [string, string] | [string, string, string] }
        : null;
    case "dataBar":
      return colors[0] ? { kind: "bar", color: colors[0] } : null;
    default:
      return null;
  }
}
