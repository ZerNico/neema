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
  limit, an unknown locale or time zone) still uses its number and comes back as refused, so the
  client drops it rather than resending forever. A reset frame carries the client's last number,
  telling it which of its pending changes are already in.
- Steps are folded past 2,000 and 30 days, or sooner once they pass 32 MB. Tombstones are never
  folded, so a change from before the snapshot still finds its IDs; an editor based there gets
  the whole document and replays what it has pending.
- The model's changes come through `change`, numbered in a client of its own per generation.

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
  only a spill's own values are ever cleared, so a typed value always blocks a spill. A
  formula the engine cannot read shows `#NAME?`.
- Without a context (the Excel file tools) `NOW`, `TODAY` and the `RAND` functions stay
  uncalculated and keep the file's value, for Excel to compute on open.

## Tests that hold it

`model/property.test.ts` checks formulas against Excel's own bookkeeping after random inserts
and deletes, and three clients and a server converging through reordered and resent changes.
