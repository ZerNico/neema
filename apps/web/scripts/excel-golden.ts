/**
 * Writes the parity cases into a workbook, has Microsoft Excel (macOS)
 * calculate and save it, and stores Excel's copy as the parity fixture:
 *
 *   node scripts/excel-golden.ts
 *
 * The engine follows US-English conventions for text it reads as numbers and
 * dates, so Excel runs in that locale for the duration and gets its own
 * setting back afterwards. Excel must have no workbooks open: it is quit and
 * relaunched. Excel is sandboxed, so the file goes through its own container
 * folder, which it can open without asking for file access.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeFormula, type Cell } from "@office-kit/xlsx/cell";
import { addDefinedName, addWorksheet, createWorkbook } from "@office-kit/xlsx/workbook";
import { addExcelTable, setCell } from "@office-kit/xlsx/worksheet";
import { toFileFormula } from "../src/modules/spreadsheets/server/formulas.ts";
import { recalculate } from "../src/modules/spreadsheets/server/calc.ts";
import { dynamicCells } from "../src/modules/spreadsheets/server/dynamic-arrays.ts";
import { workbookBytes } from "../src/modules/spreadsheets/server/adapter.ts";
import {
  PARITY_BLOCK,
  PARITY_CASES,
  PARITY_DATA,
  PARITY_NAMES,
  PARITY_OTHER,
  PARITY_TABLE,
} from "../src/modules/spreadsheets/server/engine/parity-cases.ts";
import { openParityWorkbook } from "../src/modules/spreadsheets/server/engine/parity.ts";

const workbook = createWorkbook();
const legacy = addWorksheet(workbook, "Legacy");
const dynamic = addWorksheet(workbook, "Dynamic");
const data = addWorksheet(workbook, "Data");
const other = addWorksheet(workbook, "Other");
PARITY_DATA.forEach((row, r) =>
  row.forEach((value, c) => {
    if (value !== null) setCell(data, r + 1, c + 1, value);
  }),
);
addExcelTable(workbook, data, {
  name: PARITY_TABLE.name,
  ref: PARITY_TABLE.ref,
  columns: PARITY_DATA[0]!.map(String),
});
PARITY_OTHER.forEach((row, r) => row.forEach((value, c) => setCell(other, r + 1, c + 1, value)));
for (const name of PARITY_NAMES) addDefinedName(workbook, { ...name });
// A probe of the locale Excel ran in: US English writes 1,234.50.
setCell(other, 1, 4, makeFormula('TEXT(1234.5,"#,##0.00")'));
// Column A names the case; column B is the formula Excel calculates.
const authored = new Set<Cell>();
PARITY_CASES.forEach((item, index) => {
  const label = `${item.group}: ${item.formula}`;
  setCell(legacy, index + 1, 1, label);
  setCell(legacy, index + 1, 2, makeFormula(toFileFormula(`=${item.formula}`)));
  const row = 1 + index * PARITY_BLOCK.rows;
  setCell(dynamic, row, 1, label);
  authored.add(setCell(dynamic, row, 2, makeFormula(toFileFormula(`=${item.formula}`))));
});
// Formulas on Dynamic are new ones: those that need it are saved as dynamic arrays.
recalculate(workbook, { authored });
const marked = dynamicCells(workbook).get(dynamic)?.size ?? 0;

const run = (command: string, args: string[], timeout = 30_000) =>
  execFileSync(command, args, { timeout }).toString().trim();
const excelRunning = () => {
  try {
    return run("pgrep", ["-x", "Microsoft Excel"]).length > 0;
  } catch {
    return false;
  }
};
const quitExcel = () => {
  if (!excelRunning()) return;
  run("osascript", ["-e", 'tell application "Microsoft Excel" to quit saving no']);
  const deadline = Date.now() + 30_000;
  while (excelRunning()) {
    if (Date.now() > deadline) throw new Error("Excel did not quit.");
    run("sleep", ["0.5"]);
  }
};

if (excelRunning()) {
  const open = Number(
    run("osascript", ["-e", 'tell application "Microsoft Excel" to count workbooks']),
  );
  if (open > 0)
    throw new Error("Close your Excel workbooks first; Excel is restarted for this run.");
}
let previousLocale: string | null = null;
try {
  previousLocale = run("defaults", ["read", "com.microsoft.Excel", "AppleLocale"]);
} catch {
  previousLocale = null;
}

const container = join(homedir(), "Library/Containers/com.microsoft.Excel/Data/chat-golden");
const working = join(container, "excel-parity.xlsx");
const fixture = fileURLToPath(new URL("../tests/fixtures/excel-parity.xlsx", import.meta.url));
try {
  quitExcel();
  run("defaults", ["write", "com.microsoft.Excel", "AppleLocale", "en_US"]);
  mkdirSync(container, { recursive: true });
  writeFileSync(working, await workbookBytes(workbook));
  // Alerts off and a time limit: a file Excel judges damaged fails here with a
  // message instead of leaving Excel waiting on a repair dialog.
  const result = run(
    "osascript",
    [
      "-e",
      `with timeout of 300 seconds
tell application "Microsoft Excel"
  set display alerts to false
  try
    set parityBook to open workbook workbook file name (POSIX file "${working}" as text)
    calculate full
    save parityBook
    close parityBook saving no
    set outcome to "saved"
  on error errText
    set outcome to "refused: " & errText
  end try
  set display alerts to true
  return outcome
end tell
end timeout`,
    ],
    330_000,
  );
  if (result !== "saved")
    throw new Error(
      `Excel would not open the parity workbook (${result}); a case may not be a formula Excel accepts.`,
    );
  const saved = new Uint8Array(readFileSync(working));
  const check = await openParityWorkbook(saved);
  if (check.locale !== "1,234.50")
    throw new Error(`Excel did not run in US English (a probe read "${check.locale}").`);
  if (check.dynamic !== marked)
    throw new Error(`Excel kept ${check.dynamic} of the ${marked} dynamic formulas it was given.`);
  mkdirSync(join(fixture, ".."), { recursive: true });
  copyFileSync(working, fixture);
} finally {
  quitExcel();
  if (previousLocale === null) run("defaults", ["delete", "com.microsoft.Excel", "AppleLocale"]);
  else run("defaults", ["write", "com.microsoft.Excel", "AppleLocale", previousLocale]);
  rmSync(container, { recursive: true, force: true });
}
console.log(`Excel calculated ${PARITY_CASES.length} cases (${marked} dynamic) into ${fixture}`);
