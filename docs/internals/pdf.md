# PDFs

Every PDF the app reads as text goes through `DocumentParser.parsePdf`
(`attachments/server/document-parser.ts`): chat prompts and history, `read_attachment` (chat and
project files), files a tool or the computer returns (`fileForModel`), knowledge indexing and
`read_url`. A model
that takes PDFs natively gets the bytes instead, and reads scans itself.

## The worker boundary

Nothing parses, renders or recognises a PDF on the server's own thread. `modules/pdf` runs four jobs
in killable worker processes on the shared job pool (see
[presentations](presentations.md#jobs)): `read` (text layer and page kinds), `render` (JPEG pages),
`subset` (a PDF of chosen pages) and `ocr`. A hostile file, the native canvas or ONNX Runtime can
then only cost a worker. ONNX and canvas memory is native, outside the worker's heap bound, which is
why the pool defaults to one worker (`PDF_WORKERS` raises it). A job that reads scans passes its own
timeout, scaled by pages; scanned pages go four to a job, so a stop or timeout loses little.

The worker bundle keeps `unpdf`, `@napi-rs/canvas`, `onnxruntime-node`, `pdf-lib` and `yaml`
external, and `vite.config.ts` traces each into the output by name: an external that is not traced
builds green and fails on the first PDF. ONNX Runtime sends telemetry to Microsoft unless
`ORT_DISABLE_TELEMETRY` is set before it loads; the worker sets it, since local reading promises
that nothing leaves the server. `onnxruntime-node` ships every platform's binaries, so the
worker build prunes all but the building platform's. `check-production-build.mjs` forks the
emitted worker from another directory and runs every job, because workers start lazily and the
startup check never touches one.

## What a page is

`classifyPage` (`pdf/classify.ts`) decides from the text layer, the share of the page images cover
(from pdf.js's operator list, clipped to the page box) and, only when both are near zero, the ink
in a small render. It is a bounded heuristic, and its bounds are deliberate: a page mostly covered
by images with a thin text layer is a scan even under a scanner's stamp, and a page with a real
text layer, however short, is text, so an image or shapes beside real text are not read. A scan
keeps its text layer too: shown when the page is not read, replaced when it is. A page with
no text layer but plenty of ink (outlined text) is read like a scan.

A scanned page keeps its `[page N]` marker exactly, since chunking and citations key on it, and says
what happened on the next line: read from its image, or not read and why. Page counts come from the
structured result, never from counting markers.

## Who reads scans

The admin chooses in Documents: not at all, on this server (PP-OCRv6 through our own port of
RapidOCR's processing on ONNX Runtime, measured against RapidOCR), Mistral OCR, or a vision model.
Mistral OCR takes a base URL, so any service speaking its API works (its EU endpoint, a
reseller). The normalized request endpoint, including scheme, host, port and path, is part of the
engine's fingerprint, and the model id stays pinned.
Only scanned pages leave the server, never the whole file: Mistral gets a PDF of just those pages,
a vision model one rendered image a page. The admin page confirms choosing an outside reader,
naming every path pages arrive from; the server function takes the choice as given. A vision
model is approved as its connection (provider, base URL, model key) is at that moment. An edit to
any of them stops sending until an admin saves again, as semantic search does. Each page carries
that approval into the gateway, which checks the same resolved connection it uses for dispatch,
after rendering and any queue wait. A mismatch sends nothing and publishes no text for that page.
Already-read pages keep their usage and approved cache identity. The connection is part of the
engine's fingerprint, so a re-approved one reads pages again.

Mistral response bodies are byte-bounded while streaming, including errors and decompressed bodies
without a length header. Overflow cancels the body before JSON parsing. Results must contain at most
the batch's four pages, with unique in-range integer indices and bounded Markdown strings.

The local model files are fetched when the option is saved, never shipped: pinned to a revision of
PaddlePaddle's own repositories and to a sha256, which is the trust anchor, since the hub redirects
to whichever CDN serves them. Progress and the last failure are process memory; a restart checks the
disk again and resumes a missing download if local reading is on. A reader never waits on a
download: until the files are ready, scans are unread with that reason.

Paid readings are `ocr` rows in `usage_events`, billed to whoever's action needed them (the sender,
whose chat or research run read a web PDF, a collection's owner, a project file's reader).
`read_url` reads at most five scanned pages of a web PDF, within its tool timeout.

## Fingerprints and caches

`parsedWith` names what produced a text: `pdf-<revision>` when the file has no scans, which stays
current under any scan setting, else `pdf-<revision>+scan:<engine>`. A result where an engine
failed on pages gets `+incomplete`, which no setting ever matches. So changing the scan setting
re-reads only files with scans, a knowledge rebuild re-reads exactly the incomplete or differently
read ones (`currentPdfFingerprints` is its valid set), and a prompt's cached text is reused only
while current settings would produce it.

Read scan pages are cached per blob and engine (`attachment_blobs.scanned_pages`), page by page and
independent of limits, so callers with different limits share them and a reader needing more pages
reads only the missing ones. One reader per blob and engine runs at a time; a second waits and finds
the first one's pages. A failed page is never cached.

## Waiting for it

Reading stops once the text passes the caller's character limit, and a document that must be
complete is refused before any scan is read when its text layer alone overflows, so pages are never
paid for to be cut off. A setting that cannot read yet (files still downloading, a model awaiting
approval) leaves pages unread and the extraction incomplete; collections read them on the next
Rebuild all.

Scans are read when something first needs their text, not at upload: uploading alone never sends a
page anywhere. A generation that waits reports "Reading scanned pages · 4 of 12" through a `status`
stream event: live only, never a chunk, so it takes no `seq`, and a subscriber joining mid-read is
sent the latest one. The wait sits inside the generation, under the flusher that renews its lease.
A PDF that cannot be read at all becomes a sentence saying so; it never fails the answer.

Knowledge extraction renews its lease every thirty seconds while a parse runs and stops once it is
lost. A transient reader failure puts the version back with a delay (`lease_until` doubles as the
earliest retry on a queued row) instead of spending an attempt at once; the last attempt publishes
what was read, the unread pages disclosed.
