# Spreadsheets

Excel editing follows the [presentation](presentations.md) pattern: fixed, trusted
operations in the Node app, no model-authored code. The model inspects an authorized
`.xlsx`, creates or opens a private working draft, edits an exact revision, and publishes
one workbook through the shared [file lifecycle](files.md#files-into-tools). Kept drafts,
Resume, skill templates (`skill:` references) and desktop imports work as for decks.

## One operation table

`modules/spreadsheets/operations.ts` describes every edit once; validation, the schema the
model is offered, the adapter's types and the activity's change summary derive from it.
`setCells` writes blocks of values and formulas; the rest format ranges, size columns and
rows, merge, freeze, filter, manage sheets and names, and add charts. A batch commits
atomically: one failing operation undoes the call and names its path.

Rows and columns cannot be inserted or deleted. Every formula, merge, table, filter and
chart pointing past them would need its references shifted, and a half-done shift silently
corrupts a workbook; the model writes cells where they belong instead. Renaming a sheet does
update references to it in formulas, names and charts, outside string literals.

## Calculation

Formulas are calculated when a workbook is edited, and each result is stored as the
formula's cached value, so the model checks its own work (results and errors come back in
the edit), previews show values, and any reader sees results. `calcPr fullCalcOnLoad` is
always set, so Excel recalculates everything on open regardless.

The engine is our own, in `packages/sheet/src/engine/`: a parser for Excel formula syntax, an
evaluator, and dependency ordering in `calculate.ts` over a cell storage. The file tools hand it
their workbook through the store in `server/calc.ts`. Functions whose result depends on the
moment, chance or the machine (`NOW`, `RAND`, `CELL`) are left to Excel, which calculates on open. Aggregates, criteria (`SUMIF` and kin),
lookups, dates, text parsing and formatting, information functions and the dynamic-array
functions are ours; the long tail of maths, statistics and finance comes from
`@formulajs/formulajs` (MIT), which never sees an error value or a range with text in it.
HyperFormula would have been less work, but is GPL-3.0; the choice was licence over breadth.

### Legacy and dynamic formulas

The same text means two things in Excel. A formula saved with the `XLDAPR` cell mark
(`cm` in the sheet, `xl/metadata.xml`) is a dynamic-array formula: ranges are used element by
element and the result spills. A plain formula is a legacy one: a range where one value
belongs meets the formula's own row or column (implicit intersection), so `=A1:A3*10` in row
2 is `A2*10`. Excel 365 still reads every unmarked formula that way, which is why the mark
matters and why each function says, per argument, whether it takes a value, a reference or
an array (`kinds` in the engine's `functions.ts`).

- Formulas already in the file keep the semantics they were saved with. The file library
  drops `cm`, so `server/dynamic-arrays.ts` reads the marks from the raw parts on open and
  writes them back after saving.
- Formulas the model writes follow Excel 365. One that relies on arrays (a range met a
  single-value place, the result is several cells, or it calls an array function) is saved
  as a dynamic array with the mark, spilling into the cells beside it; any other stays
  plain, so older Excel shows it without braces.
- Spills are written as plain values, as Excel writes them. A cell in the way gives
  `#SPILL!`; writing into a spill is allowed and does the same. Readers of a spill are
  ordered after its formula by last time's extent; a spill that changed shape triggers
  another pass, at most three.
- `#SPILL!`, `#CALC!` and other newer codes cannot be stored as plain cached errors: Excel
  refuses the whole file. They are kept for the edit's report, and the file stores no
  cached value there; readers calculate again.

### Parity with Excel

`engine/parity-cases.ts` holds about 400 formulas. `scripts/excel-golden.ts` enters each
once as a legacy formula and once as a new one, saves through the same path as an edit, has
Microsoft Excel for Mac calculate and save the workbook, and stores Excel's copy as
`tests/fixtures/excel-parity.xlsx`. `engine/excel-parity.test.ts` clears every result and
recalculates, and fails on any difference not listed with its reason, including a dynamic
mark we should have written but did not. The script runs Excel in US English for the
duration (the engine reads and formats text with US conventions) and restores the setting;
it refuses to run while workbooks are open. A case Excel will not accept as a formula makes
the whole file fail to open, so bisect by group when adding cases.

- Order is Kahn's algorithm over formula cells, never recursion, so a long chain of cells
  each reading the one above cannot overflow the stack. A range read by several formulas is
  one graph node, so a hundred `SUM(A:A)` cost one scan of the column. Cells left over sit
  on or behind a cycle: they read 0 and are reported as `#CIRCULAR`, as Excel shows them.
- `INDIRECT` and `OFFSET` compute their references at run time, so a formula they reach
  that is not yet done is computed on demand, to a bounded depth.
- `TEXT`, `FIXED` and `DOLLAR` format through `@chat/sheet/number-format`, our own reading
  of Excel's format codes with locale tables and no `Intl`, so the server and every browser
  write the same text for a value. The parity cases are its reference.
- What the engine does not evaluate keeps the value the file carried and is listed as not
  calculated: volatile functions (`NOW`, `RAND`), `LAMBDA`, `CELL`, tables it cannot find,
  and any function neither side has. A new formula among them that calls an array function
  is still saved dynamic, for Excel to spill.
- Functions newer than Excel 2007 are stored with their `_xlfn.` prefix (`_xlfn._xlws.` for
  `FILTER` and `SORT`), and `LET` and `LAMBDA` names as `_xlpm.`, or Excel shows `#NAME?`.
  Excel 365's typed shorthands have no file form: `A1#` is stored as `ANCHORARRAY(A1)` and
  `@x` as `SINGLE(x)`. Excel's `calcChain.xml` is dropped on save, since an edit can leave it
  naming removed cells, which Excel repairs; it rebuilds its own.
- Wildcards (`*`, `?`) in criteria, lookups and `SEARCH` come from cells, so they are matched
  without regular expressions: stars turned into `.*` backtrack exponentially. Shared formulas
  are expanded to one formula per cell before editing, so an edit to one member never moves
  the others.
- Dates are 1900-system serials, including Excel's fictitious 29 February 1900 (serial 60).
  The 1904 system is not modelled.

## Containment

Workbooks are parsed and calculated in killable worker processes of their own, run as
[jobs](presentations.md#jobs) like the presentation workers but separate from them, since
those carry the renderer and fonts. A workbook's formulas can be made
arbitrarily expensive, so cells (1,000,000), formulas and dependency links are bounded and
the kill timeout ends the rest. Macro-enabled workbooks, embedded OLE objects and form
controls are refused; pivot tables and other parts the library does not model are carried
through byte for byte but not refreshed.

## Previews

A workbook is only ever a file: the model edits it with the tools above, and people look at it in
a read-only grid, as Claude's file viewer does. There is no second editor whose model a file
would have to survive.

`/api/spreadsheets/:kind/:id` returns one sheet as the file stores it (`server/preview.ts`):
values, and a formula's cached result beside its text, never recalculated, since a reader
should see what Excel saved, not where our engine differs. Only the results a file was saved
without (some writers leave them out) are calculated, for showing alone, and every stored value
is put back after; `inspect_spreadsheet` reads the same way, so the model sees what the person
does. Styles come with theme and
indexed colours resolved (`server/file-colors.ts`), and with widths, heights, merges, panes,
hidden rows and columns, conditional formats, pictures and where each chart sits. Cells are
bounded per sheet; past the bound whole rows are left out and the reply says so. It shares the
access check and content-hash cache with the presentation route (`server/office-preview.ts`).
The client draws it with `@chat/sheet-react`'s grid, its formula bar showing the stored formula.

In a chat, a person comments on selected cells of an attachment: the comment goes out as an
ordinary message naming the file's reference and the range (`chat/comment-message.ts`), which
the model reads with `inspect_spreadsheet` and answers with an edit and a new file. Nothing is
stored on the file, so every way a message travels (retry, edit, branch, queue) carries it.

Charts are drawn by the PowerPoint renderer, since Excel and PowerPoint store charts in the
same format: the spreadsheet worker takes a chart's own XML, the workbook's theme and its size
on the sheet, and the presentation worker draws it on a blank slide of that size. Colours,
fonts, axes and legend are therefore the file's. The renderer draws the values a chart stores
beside its cell references, so every save refreshes those stored values from the cells, as
Excel does; without them other readers show empty charts too. A chart saved without them is
drawn from the cells for the preview only. The chart library reads no series names, so they are
restored onto each loaded chart from its own part (by drawing order and series index); a
name read from a cell keeps its text beside the reference, as Excel writes it. A new workbook carries Excel's Office theme, so
readers agree on its colours. Each chart is drawn over the grid at its anchor; newer chart
kinds (chartex) and charts past a sheet's limit are counted, not drawn.
