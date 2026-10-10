# Live sheets

A live sheet is a kind of document: a grid people and the model edit at once, ordered by the
server like text documents. The core is `packages/sheet` (headless, shared by the server,
browser workers and the Excel file tools); this page records the decisions behind it.

## Stable IDs, formulas held by them

- Rows, columns and sheets are order lists of stable IDs; cells are keyed by row and column
  ID, never by position. A formula is text pieces and references, and a reference holds its
  sheet, rows and columns by ID with each `$` as written (`model/formula.ts`). A1 text is made
  only where someone reads it: the formula bar, the model's view, the evaluator and export.
  It is never parsed back after a structural change, so an insert changes no formula.
- 3-D references (`First:Last!A1`) stay positional within each sheet, as Excel's are. Names'
  identifiers are text; their definitions are formulas like any other. `INDIRECT` text stays
  positional.
- A range reaching Excel's last row or column is open-ended there and follows the grid. A
  reference past the grid is not guessed at: parsing reports the growth it needs, and the
  caller inserts rows or columns first.
- Copy and fill shift relative parts by position (`copyFormula`) and are sent as plain cell
  writes. Cut (`move`) redirects every reference wholly inside the moved cells, and `sort`
  carries an explicit row order, computed once by whoever sorts; moved formulas shift as a
  copy would and references from elsewhere keep their positions, as in Excel.

## Deleting

- Deleting marks entries dead and keeps their place, so an insert or a comment anchored to
  one still lands where it was, and reviving brings a single cell's references back.
- A delete moves existing range endpoints off the deleted rows to the nearest live row inward,
  in the same change. Resolving them only when read would let a row later inserted beside a
  dead endpoint join the range, which Excel never does. Reading still resolves a dead endpoint
  inward, for a formula written against the old rows that arrives late.

## Applying changes

- `applyChange` is total and deterministic: the same document, change and revision give the
  same result on every replica, and nothing throws. A part naming something gone is dropped
  and reported in words; the rest applies. With one server order this is the whole
  convergence argument; replicas rebuild what they show by replaying their unconfirmed
  changes over what the server confirmed.
- A change carries its client and a sequence number. The server applies exactly the next
  number from a client; an earlier one is a resend, acknowledged and not applied again, and a
  later one would skip a change and is refused. Clients send in order, the next after the
  last is acknowledged.
- Every content write records its revision on the cell (`w`, and `wf` for formats); a clear
  is a write and keeps the version, so a guard can tell a cell someone emptied from one that
  was always empty.
- Styles are stored as a canonical key (properties in a fixed order), so replicas agree on
  the key without sharing a table.

## Serving a sheet

- A sheet is a `documents` row of kind `sheet`: the snapshot is the document's JSON and each
  `document_steps` row one change. `SheetService` keeps it in memory and orders writes like the
  text service, but checks no base revision: changes name IDs, so one built on any earlier
  revision applies as it is. Edits travel as JSON text (`pushSheet`), the feed at
  `/api/sheets/:id/stream`.
- Each client's last applied sequence number is kept in `sheet_clients`, apart from the steps,
  so folding the log never makes an old change look new. A push applies only the run that
  follows it; a resend is acknowledged, a gap waits. A change the server will not keep (over a
  limit, an unknown locale or time zone) still uses its number and comes back as refused; the
  tab drops it at once, since the feed will never bring it. A push refused whole (a change that
  does not parse, a sheet now read-only) is answered, not thrown, so it is not retried: the tab
  drops that client's unsent changes and numbers its next one where they began. A reset frame carries the client's last number,
  telling it which of its pending changes are already in.
- Steps are folded past 2,000 and 30 days, or sooner once they pass 32 MB. Tombstones are never
  folded, so a change from before the snapshot still finds its IDs; an editor based there gets
  the whole document and replays what it has pending.
- The model's changes come through `change`, numbered in a client of its own per generation.

## The model

- `create_sheet` and `edit_sheet` load on request like the Office tools. An edit is a list of
  operations by sheet name and A1, the Excel tools' catalogue less filters, plus inserting,
  deleting, filling, copying, sorting, moving sheets and charts. They are converted in order
  (`server/convert.ts`), each against what the ones before it made, into one change; one refused
  operation refuses the call. The grid grows to hold what is written.
- The guards trust only what a sent request showed (the revision a staged view carried) and the
  revisions the answer wrote itself. A write, a clear, a delete or a sort over a cell whose
  write version is newer than both is a conflict. Bumping the seen revision on the model's own
  write would let it overwrite a person's edit it never saw.
- The focused sheet's view (`server/sheet-view.ts`) is calculated on the server and sent whole
  whenever it changes; the first view of an answer stays byte for byte, as for text. It lists
  charts and open threads by cell, and names the person's selection, which a message carries
  as the sheet, anchor and head IDs in the field text uses for blocks.
- While a call's arguments arrive, its finished operations, and the finished rows of a
  `setCells` still being written, go in under the lighter fence. The decoded call writes only
  what is left, so nothing is applied twice. An edit no call claims, or whose call is refused,
  is undone write by write, newest first, so a person's edit made in between stays; a sheet an
  unclaimed call created is removed.
- `fromFile` starts a sheet from an Excel file, read in a spreadsheet worker, or a CSV. What a
  live sheet keeps: values, formulas (legacy arrays with their extent), styles the format
  operation knows, sizes, merges, panes, names and charts of the kinds it draws. What it drops,
  and the model is told: other chart kinds, tables' formatting, filters, conditional
  formatting, validation and notes. A file over the live limits is refused and left to the
  Excel tools.
- A download is built in the spreadsheet worker from the stored sheet, by position, charts
  included, and calculated there, so the file opens with every value.

## Filters

- A sheet's AutoFilter is data in the document (`model/filter.ts`): a range by IDs and, per
  column, the shown values to keep or a condition. The rows it hides are worked out from the
  values whenever the sheet is drawn and never stored as hidden, so an edit that changes a
  value shows or hides its row on every replica without a change of its own, and taking the
  filter off cannot leave rows hidden.
- Excel does not filter when it opens a file, so a download saves the rows a filter hides as
  hidden rows, and a condition as the values that pass it. An import gives those rows back to
  the filter instead of hiding them by hand.

## Rules on cells

- Conditional formats and data validation are lists on the sheet, each rule a range by IDs,
  replaced whole by one operation. How a cell looks under a format, and whether its value
  breaks a rule, are worked out from the values at draw time like a filter's rows, so neither
  is ever stale on a replica.
- Validation guards typing in the grid only. A paste, a fill or the model may write anything,
  which is Excel's behaviour too; Circle Invalid Data shows what slipped through. A list read
  from cells keeps that range by IDs and its choices are the cells' shown text.
- Excel keeps a format's look as a differential style. The library writes those but cannot
  read them, so an import reads them from the stylesheet's XML
  (`spreadsheets/server/file-conditional.ts`). Rule kinds a live sheet does not draw (icons,
  formulas, time and custom validation) are dropped on import and named as dropped.

## Pictures

- A picture's bytes are in the document, a data URL downscaled on the device first, not an
  attachment. It so has the document's access, undo, copies and live sync, and needs no owner
  kind of its own; the document's byte limit bounds them. SVG is refused, as it can carry
  script, and a file's pictures too large to keep are named as dropped.

## Pivot tables

- A pivot table is a `GROUPBY` or `PIVOTBY` formula, as Excel 365 writes one, not a separate
  object with its own cache. It recalculates with its data like any formula, every replica
  agrees on it, and a download keeps it as the formula Excel reads.
- Their function argument is a bare aggregate name, Excel's eta form, stored in files as
  `_xleta.SUM`. One given as a `LAMBDA` is beyond the engine, so that cell keeps its value.

## Links

- A cell's link is a property of its style, not of its content. It then moves with every copy,
  fill, sort and paste of formats, survives Delete and retyping as Excel's hyperlinks do, and
  undoes like any format. Clearing formats takes it off.
- Only web and mail addresses are kept from the model, a paste or a file, and only those are
  opened. In an Excel file a link is a hyperlink with the Hyperlink style's look, which an import
  leaves out again so the grid draws it in the theme's own colour.

## Charts

- A chart is data in the document (`model/chart.ts`): its series by IDs and every option set,
  never its values; each replica draws it from the cells. Its text is literal or a cell it
  follows. It sits on a cell by IDs with a pixel offset into it, as Excel anchors one, so
  it moves with inserts above it and stays where it was dropped.
- `chartPatch` replaces each top-level option it names, merges axes and style one level down
  and replaces series whole. Two people changing different options both keep theirs, undo
  included.
- A chart made from a range keeps that range and how it was read (header row, label column,
  series along rows). A new kind, a changed range or a flipped toggle reads it again, keeping
  each series' own options by place, so a pie keeps one series and columns get them all back.
- The app compiles a chart for `@tanstack/charts` on every draw (`ui/chart-compile.ts`). That
  library has no chart titles and puts legends only above or below, so both are the page's;
  an image of a chart redraws them around the library's exported plot.
- One mapping turns a chart into Excel's chart parts and back
  (`spreadsheets/server/file-charts.ts`), for downloads, imports and the Excel tools alike.
  Excel's legacy chart here holds one chart group with two axes, so a subtitle, the right axis
  and series drawn as another kind are left out of the file. Waterfall and histogram are
  Excel's newer chart types and keep only their data and title.

## Showing it

- `@chat/sheet-react` draws only the grid, from the document and the values: cells in view,
  frozen panes drawn again over the scrolling ones on the same coordinates, other people's
  selections, comment marks and overlays such as charts. Selection, editing and commands are
  reported up; the app draws the formula bar, toolbar, menus, tabs, threads and find bar, and
  turns commands into operations (`commands.ts`, pure and tested without React).
- A tab shows the server's document with its own unsent changes replayed on top
  (`client/sheet-sync.ts`); its own change coming back through the feed, or an acknowledgement,
  retires it. Unsent changes are kept on the device one per key, by client and number, and
  only those the server has answered are removed, so a tab never erases another's newer ones. A
  tab sends any it finds under the client that made them and makes its own edits under a new
  one, so two tabs resending the same changes is harmless.
- Undo walks the tab's own history: each step keeps the document before and after, and
  `invertChange` puts back only what still holds what the step left. Someone else's later edit
  stays, whether to a cell, a size, a rule (lists go item by item) or a chart's or picture's
  field.
- Comment threads sit on a cell, or a range from it to a far corner, through the document's
  anchors, written as a change of their writer's own, so a thread follows its cells through
  inserts and sorts. A range whose far corner is deleted keeps its first cell.
- An Excel file's notes come in as threads of a third origin, `file`, beside a person's and the
  assistant's. They keep the author's name as the file gave it and are never matched to an
  account: a name in a file proves nothing about who wrote it. Excel saves each threaded comment
  as a note too, so those come in with their replies. A download writes each open thread as one
  note on its first cell; a note has no replies, so they go into its text.

## Calculating

- Values are never stored: every replica calculates them from the document and a
  `CalcContext` (`model/calc.ts`): the revision, an epoch, the moment and a seed. The moment is
  the revision's commit time in the sheet's time zone, given by the server, so `NOW` and
  `TODAY` change with each edit, as Excel's volatile functions recalculate, and no replica
  needs time-zone data. Chance is a seeded stream per random call, keyed by the seed, the
  cell's IDs and the call's place in the formula, so replicas draw the same numbers, two
  `RAND()`s in one formula differ, and an insert above a cell does not change its draws.
- Formulas reach the engine as text rendered at current positions. Every formula written
  live follows Excel 365, spilling; results and spilled values sit beside the document and
  only a spill's own values are ever cleared, so a typed value always blocks a spill. So does
  the grid's edge: a spill past the last row or column is `#SPILL!` until the grid grows, as at
  Excel's edge, since growing it while calculating would give each replica different IDs. A
  formula the engine cannot read shows `#NAME?`.
- Without a context (the Excel file tools) `NOW`, `TODAY` and the `RAND` functions stay
  uncalculated and keep the file's value, for Excel to compute on open.
- An open sheet calculates in a worker. Each request carries a generation and only the newest
  is calculated; a typed value shows at once and a formula keeps its last result until the new
  one. A full recalculation of 10,000 formulas, a 5,000-long chain among them, takes about
  60 ms on an M-series Mac, so calculation stays whole rather than incremental.

## Tests that hold it

`model/property.test.ts` checks formulas against Excel's own bookkeeping after random inserts
and deletes, and three clients and a server converging through reordered and resent changes;
`model/invert.test.ts` that undoing any change brings back what the sheet showed. Export and
import are tested as a round trip through the Excel tools' own reader.
