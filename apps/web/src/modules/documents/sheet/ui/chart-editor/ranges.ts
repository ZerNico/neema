import { boxRef, parseCell, parseRange } from "@chat/sheet/a1";
import { liveSheets, positions, type Box, type SheetDoc } from "@chat/sheet/model";
import type { CellAt, ChartText } from "@chat/sheet/model/chart";

/** A sheet name as a reference writes it: quoted when it holds anything but letters and digits. */
const sheetRef = (name: string) =>
  /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : `'${name.replaceAll("'", "''")}'`;

/** A range by IDs as A1 text, naming its sheet when it is not `home`; `#REF!` once its cells are gone. */
export function rangeText(doc: SheetDoc, home: string, sheet: string, box: Box): string {
  const data = doc.sheet[sheet];
  if (!data) return "#REF!";
  const rows = positions(data.rows);
  const cols = positions(data.cols);
  const [top, bottom, left, right] = [
    rows.at(box.r1),
    rows.at(box.r2),
    cols.at(box.c1),
    cols.at(box.c2),
  ];
  if (top === undefined || bottom === undefined || left === undefined || right === undefined)
    return "#REF!";
  const ref = boxRef({ top, bottom, left, right });
  return sheet === home ? ref : `${sheetRef(data.name)}!${ref}`;
}

/** "B2:D9" or "Sheet2!B2:D9" to a range by IDs, or null when it names no live cells. */
export function readRange(
  doc: SheetDoc,
  home: string,
  text: string,
): { sheet: string; box: Box } | null {
  const trimmed = text.trim().replace(/^=/, "").replaceAll("$", "");
  const bang = trimmed.lastIndexOf("!");
  let sheet = home;
  if (bang !== -1) {
    const name = trimmed
      .slice(0, bang)
      .replace(/^'(.*)'$/, "$1")
      .replaceAll("''", "'");
    const found = liveSheets(doc).find(
      (id) => doc.sheet[id]!.name.toLowerCase() === name.toLowerCase(),
    );
    if (!found) return null;
    sheet = found;
  }
  const box = parseRange(bang === -1 ? trimmed : trimmed.slice(bang + 1));
  const data = doc.sheet[sheet];
  if (!box || !data) return null;
  const rows = positions(data.rows).ids;
  const cols = positions(data.cols).ids;
  if (box.bottom > rows.length || box.right > cols.length) return null;
  return {
    sheet,
    box: {
      r1: rows[box.top - 1]!,
      r2: rows[box.bottom - 1]!,
      c1: cols[box.left - 1]!,
      c2: cols[box.right - 1]!,
    },
  };
}

/** Chart text as typed: "=A1" for a cell it follows, else the text itself. */
export function textOf(doc: SheetDoc, home: string, value: ChartText | undefined): string {
  if (!value) return "";
  if ("text" in value) return value.text;
  const { sh, r, c } = value.cell;
  return `=${rangeText(doc, home, sh, { r1: r, r2: r, c1: c, c2: c })}`;
}

/** What was typed as chart text: "=A1" follows that cell, anything else is fixed text; empty clears it. */
export function readText(doc: SheetDoc, home: string, typed: string): ChartText | null {
  const trimmed = typed.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("=")) {
    const range = readRange(doc, home, trimmed);
    const single = range && range.box.r1 === range.box.r2 && range.box.c1 === range.box.c2;
    const ref = trimmed.slice(1).split("!").at(-1) ?? "";
    if (range && single && parseCell(ref.replaceAll("$", ""))) {
      const cell: CellAt = { sh: range.sheet, r: range.box.r1, c: range.box.c1 };
      return { cell };
    }
  }
  return { text: trimmed.slice(0, 200) };
}
