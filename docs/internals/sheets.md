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

## Tests that hold it

`model/property.test.ts` checks formulas against Excel's own bookkeeping after random inserts
and deletes, and three clients and a server converging through reordered and resent changes.
