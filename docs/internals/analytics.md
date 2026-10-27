# Analytics

Usage analytics reads one table, `usage_events`, and nothing else. Every model call that
costs something appends a row to it when it settles. Rows are never updated, and are deleted
only with their user, so the dashboard is a set of sums over an append-only ledger.
`messages.usage` is what the reader sees on one answer, not a source for analytics.

## What writes a row

- **Chat:** one row per attempt, written in the same transaction that makes the message
  terminal (`finalizeMessage`, `failGeneration`), so the two commit together. A retry or a
  [resume](resume.md) appends another. A generation that fails before it starts still writes an
  `error` row. One the reaper ends after its process died writes none: what it used was never
  reported.
- **Title, compaction and command review:** their own kinds, one row per call.
- **Research:** one aggregate `chat` row per run, keyed by the run's id, beside the host
  attempt's own row. Research compaction gets its own row keyed by its call. See
  [research](research.md#usage-and-ledger).
- **Images:** one `image` row per operation, written by a finalizer whatever happened. See
  [images](images.md#the-ledger).
- **Embeddings and OCR:** `embedding_document`, `embedding_query` and `ocr` rows, billed to
  whoever's action needed them: a collection's owner for indexing, the searcher for a query,
  and for scans the person named in [PDFs](pdf.md).

## A row stands on its own

- The row keeps what it needs after everything around it is gone: the model's display name,
  the cost, and conversation and message ids as plain text, with no foreign key. Deleting a
  chat, temporary or not, leaves the ledger as it was.
- Cost is resolved when the row is written (`resolveCost`) and stored. A later price change
  never rewrites history. The provider's reported cost wins. Rounds it did not cover are
  priced from the model's rates, and without either the cost is null, never zero.
- `model_id` is the one link back, and deleting the model clears it. A model can be deleted
  while its call runs, so every insert links through `liveModelId`, which locks the model row
  for the length of the write or finds it gone and links nothing. Inserting the id directly
  fails the write with a foreign-key error, inside the transaction that finishes the answer.
  Rows from a service with no model entry (Mistral OCR) carry no link from the start.

## Reading it

- Windows are half-open, `from` inclusive and `to` exclusive, so the previous period used for
  the deltas ends exactly where this one starts. Presets are whole UTC days, matching the daily
  buckets.
- A sum of costs is only a total when every row in it is known. `costComplete` is false when
  any row has no cost or incomplete usage, and the UI then shows the sum as a floor (“at least”)
  or as unknown, never as a smaller total.
- Errors and aborts are both attempts. The error rate counts `error` only. A Stop is not a
  failure.
- By model, a row with a link groups under the model and shows its current name, so a rename
  keeps one line. A row without one groups by the name it was saved with. The dashboard marks
  such a line “(deleted)” only when a current model shares its name.
- Token sums stay `bigint` in SQL and are rejected beyond JavaScript's safe integers rather
  than rounded.
- Admins read the whole instance. Everyone else reads only their own rows, with the user id
  taken from the session.
