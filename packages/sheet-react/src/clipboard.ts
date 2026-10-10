import { XError } from "@chat/sheet/engine/values";
import { LIVE_LIMITS } from "@chat/sheet/model/limits";
import type { StylePatch } from "@chat/sheet/model/ops";
import { selectionBox, type ForeignCell, type GridContext } from "./commands.ts";
import { cellDisplay, cellStyle, safeLink } from "./display.ts";

/**
 * HTML on the clipboard, as Excel and Google Sheets exchange cells with
 * their looks: a table whose cells carry inline styles, numbers marked as
 * both programs mark them so they paste as numbers and not as their text.
 */

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapeAttribute = (text: string) => escapeHtml(text).replaceAll('"', "&quot;");

/**
 * One cell as an HTML table cell, its style inline as Excel and Google
 * Sheets read it. `aligned` writes the alignment a cell has without one
 * (numbers right), for a page drawn by itself, as a print is.
 */
export function cellHtml(
  context: Pick<GridContext, "doc" | "sheet" | "values" | "locale">,
  r: string,
  c: string,
  aligned = false,
) {
  const sheet = context.doc.sheet[context.sheet]!;
  const style = cellStyle(sheet.cells[r]?.[c]?.s);
  const value = context.values.value(context.sheet, r, c);
  const shown = cellDisplay(value, style, context.locale);
  const css = [
    style.bold && "font-weight:bold",
    style.italic && "font-style:italic",
    (style.underline || style.strike) &&
      `text-decoration:${[style.underline && "underline", style.strike && "line-through"].filter(Boolean).join(" ")}`,
    style.fontFamily && `font-family:${style.fontFamily}`,
    style.fontSize && `font-size:${style.fontSize}pt`,
    (shown.color ?? style.fontColor) && `color:${shown.color ?? style.fontColor}`,
    style.fill && `background-color:${style.fill}`,
    (aligned || style.horizontal) && `text-align:${style.horizontal ?? shown.align}`,
    style.vertical && `vertical-align:${style.vertical === "center" ? "middle" : style.vertical}`,
    style.wrap && "white-space:normal",
    style.borderTop && "border-top:1px solid #000000",
    style.borderBottom && "border-bottom:1px solid #000000",
    style.borderLeft && "border-left:1px solid #000000",
    style.borderRight && "border-right:1px solid #000000",
    style.numberFormat && `mso-number-format:'${style.numberFormat.replaceAll("'", "\\'")}'`,
  ].filter(Boolean);
  const number =
    typeof value === "number"
      ? ` x:num="${value}" data-sheets-value="${escapeAttribute(JSON.stringify({ 1: 3, 3: value }))}"`
      : "";
  const text = value instanceof XError ? value.code : shown.text;
  // Excel reads a break kept inside its cell from this mark.
  const content = escapeHtml(text).replaceAll("\n", '<br style="mso-data-placement:same-cell;">');
  const link = safeLink(style.link);
  const linked = link ? `<a href="${escapeAttribute(link)}">${content}</a>` : content;
  return `<td${css.length ? ` style="${escapeAttribute(css.join(";"))}"` : ""}${number}>${linked}</td>`;
}

/** The selection as an HTML table, each cell's style inline. */
export function selectionHtml(context: GridContext): string {
  const box = selectionBox(context);
  const rows = box.rowIds.map(
    (r) => `<tr>${box.colIds.map((c) => cellHtml(context, r, c)).join("")}</tr>`,
  );
  return `<meta charset="utf-8"><table><tbody>${rows.join("")}</tbody></table>`;
}

/** A CSS colour as #RRGGBB, or null for one that is not a plain colour. */
function hexColor(text: string): string | null {
  const value = text.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(value);
  if (short)
    return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toUpperCase();
  if (/^#[0-9a-f]{6}$/.test(value)) return value.toUpperCase();
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(value);
  if (rgb) {
    if (rgb[4] !== undefined && Number(rgb[4]) === 0) return null;
    return `#${[rgb[1], rgb[2], rgb[3]]
      .map((part) => Math.min(255, Number(part)).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()}`;
  }
  return value === "black" || value === "windowtext"
    ? "#000000"
    : value === "white"
      ? "#FFFFFF"
      : null;
}

/** Fonts and sizes both programs give every cell, which a pasted cell then does not keep. */
const DEFAULT_FONTS = new Set(["calibri", "aptos", "aptos narrow", "arial"]);
const DEFAULT_SIZES = new Set([10, 11]);

/** Excel's named formats as their codes; empty for those a cell has without one. */
const NAMED_FORMATS: Record<string, string> = {
  general: "",
  "@": "",
  standard: "#,##0.00",
  fixed: "0.00",
  percent: "0.00%",
  "short date": "m/d/yyyy",
  "long date": "dddd, mmmm d, yyyy",
  "short time": "h:mm",
  "long time": "h:mm:ss AM/PM",
  scientific: "0.00E+00",
};

/** Declarations as a cell's style, leaving out what every cell has unless set. */
function styleOf(declarations: ReadonlyMap<string, string>): StylePatch {
  const style: Record<string, string | number | boolean> = {};
  const get = (name: string) => declarations.get(name)?.trim().toLowerCase();
  const weight = get("font-weight");
  if (weight === "bold" || weight === "bolder" || Number(weight) >= 600) style.bold = true;
  if (get("font-style") === "italic") style.italic = true;
  const decoration = `${get("text-decoration") ?? ""} ${get("text-decoration-line") ?? ""}`;
  if (decoration.includes("underline") || get("text-underline-style") === "single")
    style.underline = true;
  if (decoration.includes("line-through")) style.strike = true;
  const family = declarations
    .get("font-family")
    ?.split(",")[0]
    ?.trim()
    .replace(/^["']|["']$/g, "");
  if (family && !DEFAULT_FONTS.has(family.toLowerCase()) && !/^(sans-)?serif$/i.test(family))
    style.fontFamily = family.slice(0, 64);
  const size = /^([\d.]+)(pt|px)$/.exec(get("font-size") ?? "");
  if (size) {
    const points = Math.round(size[2] === "px" ? (Number(size[1]) * 3) / 4 : Number(size[1]));
    if (points >= 6 && points <= 72 && !DEFAULT_SIZES.has(points)) style.fontSize = points;
  }
  const color = get("color") && hexColor(get("color")!);
  if (color && color !== "#000000") style.fontColor = color;
  const background = get("background-color") ?? get("background");
  const fill = background && hexColor(background);
  if (fill && fill !== "#FFFFFF") style.fill = fill;
  const align = get("text-align");
  if (align === "left" || align === "center" || align === "right") style.horizontal = align;
  const vertical = get("vertical-align");
  if (vertical === "top") style.vertical = "top";
  if (vertical === "middle") style.vertical = "center";
  if (get("white-space") === "normal" || get("white-space") === "pre-wrap") style.wrap = true;
  for (const side of ["top", "bottom", "left", "right"] as const) {
    const edge = get(`border-${side}`) ?? get("border");
    if (edge && !/\b(none|hidden)\b/.test(edge) && !/(^|\s)0(\.0+)?(px|pt)?(\s|$)/.test(edge))
      style[`border${side[0]!.toUpperCase()}${side.slice(1)}`] = true;
  }
  const format = declarations.get("mso-number-format")?.trim();
  if (format) {
    // Excel escapes its format as CSS: \0022 for a quote, a backslash before anything else.
    const unquoted = format
      .replace(/^(["'])(.*)\1$/s, "$2")
      .replace(/\\([0-9a-f]{4})/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
      .replace(/\\(.)/g, "$1");
    const named = NAMED_FORMATS[unquoted.toLowerCase()];
    if (named !== undefined) {
      if (named) style.numberFormat = named;
    } else if (unquoted) style.numberFormat = unquoted.slice(0, 255);
  }
  return style;
}

const parseDeclarations = (text: string, into: Map<string, string>) => {
  for (const part of text.split(";")) {
    const colon = part.indexOf(":");
    if (colon > 0) into.set(part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1));
  }
  return into;
};

/**
 * A pasted HTML table as cells with their styles, or null when it holds no
 * table. Excel puts styles in classes of a style sheet, Google Sheets inline.
 */
export function readHtmlTable(html: string): ForeignCell[][] | null {
  const page = new DOMParser().parseFromString(html, "text/html");
  const table = page.querySelector("table");
  if (!table) return null;
  const classes = new Map<string, string>();
  for (const sheet of page.querySelectorAll("style"))
    for (const [, selectors = "", body = ""] of (sheet.textContent ?? "")
      .replace(/<!--|-->/g, "")
      .matchAll(/([^{}]+)\{([^}]*)\}/g))
      for (const selector of selectors.split(","))
        // Classes only: element rules are what every cell has.
        if (/^\s*(td|th)?\.[\w-]+\s*$/.test(selector))
          classes.set(
            selector
              .trim()
              .replace(/^(td|th)/, "")
              .slice(1),
            body,
          );
  const grid: ForeignCell[][] = [];
  // A merged cell covers places below it that later rows skip.
  const taken = new Set<string>();
  let placed = 0;
  for (const [y, tr] of [...table.querySelectorAll("tr")].entries()) {
    const row = (grid[y] ??= []);
    let x = 0;
    for (const td of tr.querySelectorAll("td, th")) {
      while (taken.has(`${y}|${x}`)) {
        row[x] ??= { raw: "" };
        x++;
      }
      const declarations = new Map<string, string>();
      for (const name of td.classList) parseDeclarations(classes.get(name) ?? "", declarations);
      parseDeclarations(td.getAttribute("style") ?? "", declarations);
      // Formatting tags inside a cell, as rich text and older programs write it.
      const inner = td.querySelector("span[style], font");
      if (inner?.getAttribute("style"))
        parseDeclarations(inner.getAttribute("style")!, declarations);
      if (inner?.getAttribute("color")) declarations.set("color", inner.getAttribute("color")!);
      if (td.querySelector("b, strong")) declarations.set("font-weight", "bold");
      if (td.querySelector("i, em")) declarations.set("font-style", "italic");
      if (td.querySelector("u")) declarations.set("text-decoration", "underline");
      if (td.querySelector("s, strike, del"))
        declarations.set("text-decoration-line", "line-through");
      // HTML source breaks are spaces; a <br> or preformatted text is a break in the cell.
      for (const br of td.querySelectorAll("br")) br.replaceWith("\uE000");
      const kept = (declarations.get("white-space")?.trim() ?? "").startsWith("pre");
      const text = (td.textContent ?? "")
        .replace(kept ? /\r\n?/g : /\s+/g, kept ? "\n" : " ")
        .replaceAll("\uE000", "\n")
        .replaceAll("\u00a0", " ")
        .replace(/^[ \n]+|[ \n]+$/g, "");
      const number = numberOf(td);
      const link = safeLink(td.querySelector("a[href]")?.getAttribute("href") ?? undefined);
      row[x] = {
        raw: text,
        ...(number === null ? {} : { value: number }),
        style: { ...styleOf(declarations), ...(link ? { link } : {}) },
      };
      // A span is whole cells within a sheet's bounds, whatever a page wrote.
      const span = (name: string, most: number) => {
        const read = Math.trunc(Number(td.getAttribute(name)));
        return Number.isFinite(read) ? Math.min(most, Math.max(1, read)) : 1;
      };
      const [across, down] = [span("colspan", LIVE_LIMITS.cols), span("rowspan", LIVE_LIMITS.rows)];
      // A paste larger than a sheet holds is refused before its places are made.
      placed += across * down;
      if (placed > LIVE_LIMITS.cells) return null;
      for (let dy = 0; dy < down; dy++)
        for (let dx = 0; dx < across; dx++)
          if (dx || dy) {
            taken.add(`${y + dy}|${x + dx}`);
            if (!dy) row[x + dx] = { raw: "" };
          }
      x += across;
    }
  }
  const width = Math.max(0, ...grid.map((row) => row.length));
  if (!width) return null;
  return grid.map((row) => Array.from({ length: width }, (_, x) => row[x] ?? { raw: "" }));
}

/** The number a cell holds as Excel (`x:num`) or Google Sheets (`data-sheets-value`) marks it. */
function numberOf(td: Element): number | null {
  const excel = td.getAttribute("x:num");
  if (excel) {
    const number = Number(excel);
    if (Number.isFinite(number)) return number;
  }
  const sheets = td.getAttribute("data-sheets-value");
  if (sheets) {
    try {
      const read = JSON.parse(sheets) as Record<string, unknown>;
      if (read["1"] === 3 && typeof read["3"] === "number") return read["3"];
    } catch {
      return null;
    }
  }
  return null;
}
