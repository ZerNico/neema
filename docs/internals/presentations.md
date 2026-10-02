# Presentations

PowerPoint editing uses fixed, trusted operations in the Node app, not model-authored
code or a second service. The model can inspect an authorized PPTX, create a private
working deck, incrementally edit an exact revision, render selected slides for visual
feedback, and publish one editable PPTX. Working revisions and delivery are the shared
[file lifecycle](files.md#files-into-tools); they do not create project versions or
attachments until publication.

## One operation table

`modules/presentations/operations.ts` describes every edit once. Validation, the JSON
schema the model is offered, the adapter's operation types and the transcript's change
summary all derive from it through the shared [operation engine](files.md#office-families),
so a new operation is one entry there plus its adapter case.
Each tool advertises only its own parameters. Top-level parameters stay optional so
malformed calls reach handler diagnostics rather than failing the generation decoder.
Numbers are advertised as plain integers or numbers: a schema generated from `Schema.Number` also offers the strings
`"NaN"` and `"Infinity"`, and models then send them. `advertised-schemas.test.ts` guards
this. Handlers accept unambiguous near misses (null for absent, a decimal string for a
number, one ID for a list of one, a JSON string for the operation list) and otherwise
fail with the field's path and what it expected. Errors name the operation, e.g.
`operations[2] setText: …`, because a model that cannot tell which field failed repeats
the same call.

A batch commits atomically. Operations address slides by `slideId` and shapes by
`shapeId`, or by a layout `placeholder` (`title`, `subtitle`, `body`, `body2`…), or by a
`ref` a creating operation in the same batch assigned. Refs are batch-local; results return
the IDs they became. One canonical naming function serves layout inspection, slide
inspection and mutation lookup; raw OOXML types live separately in `placeholderType`.
Body names follow ascending layout indices, not surviving slide order, so deleting
`body` leaves `body2` named `body2`. `bodyN` accepts decimal integers N >= 2 without
leading zeros, within the same ten-character bound in both schema and runtime.
Ambiguous semantic names never choose the first shape: use an exact slide `shapeId`.
Unsupported placeholder types likewise require shape IDs. Filling placeholders keeps a
template's own styling, which drawing text boxes over them would lose. Move indices
are zero-based against the current slide count after earlier operations in the batch. Text and style
edits reach shapes inside a group; moving, reordering or removing one does not, because
its geometry lives in the group's coordinates, so those act on the group or after `ungroup`.

Layouts and masters are edited through `templateId` (a layout or master part, listed by
inspecting with it): a background colour, removing a shape, replacing a picture such as a
logo, and `replaceAll` with `scope: "everywhere"` for footer wording. Office Kit has no
mutable handles for those parts, so `template-edits.ts` changes their XML directly with
targeted edits, and the same preservation check follows.

## Package boundary

Office Kit parses and writes packages inside persistent worker processes, run as
[jobs](#jobs) on the shared pool in `server/worker-pool.ts` (custom tools use the same pool
with threads). A process, not a thread, because resvg is native code: `terminate()` cannot
stop a thread inside it, so a hung render kept burning CPU after its timeout, while a
process is killed outright (`server/worker-process.ts`). Each gets its own heap bound and an environment
without the server's secrets, since it parses untrusted files. Chat tools, font checks and
read-only previews share one set; previews wait behind queued tool calls, each lane refuses
work past its queue as busy, and one person's jobs beyond two wait for their own, so a
burst from one chat never holds every worker. A worker that times out, is cancelled
mid-task, crashes or exits is replaced, never reused. The parent process authorizes
sources, images and publication; workers receive bytes and validated operations, not
database credentials. The process bounds time, memory and secrets; it is not a sandbox
against native code escaping it.

### Jobs

A worker module exports its handlers, one per job `kind`, and serves them with
`serveJobs` (`server/job-worker.ts`); its runtime is `createJobRuntime` (`server/jobs.ts`)
configured with limits, a pre-flight `admit` and the family's error. The runtime's request
and result types are read from the handlers, so `run({ kind: "render" })` returns rendered
slides, never a union to narrow. Top-level request buffers are copied and handed over, the
caller's own left untouched. A failure the worker reports by name is a `JobError` subclass
(`PresentationError`, `SpreadsheetError`) with a stable `code`; anything else crosses the
boundary only as a generic failure. A new worker is a module of handlers, a runtime of
configuration, and one entry in `scripts/build-office-workers.mjs`.

Reject active content (ActiveX, OLE, macros, executables), embedded audio and video, and
external rendering dependencies rather than fetching them. Every picture relationship must
resolve inside `ppt/media/`, and parts must bind the relationships namespace to `r`, the
prefix every attribute lookup assumes.

A deck's own pictures are kept byte for byte whatever their format, so a GIF, TIFF, EMF or
40-megapixel photo never decides whether a deck opens or edits. Only the preview decodes
them, and only PNG and JPEG within the per-picture pixel bounds and one pixel budget per
render; anything else previews as the renderer's placeholder, with a warning, in a
disposable copy of the package. Pictures an edit adds must be PNG or JPEG within those
bounds, since every preview has to draw them. Embedded SVG artwork, reached only through
PowerPoint's `svgBlip`, is likewise never served on its own. A preview draws one only when
the picture lacks a drawable bitmap fallback: resvg rasterizes it into the same copy, with
the renderer's bundled faces, because without system fonts resvg drops text silently. So
that an ordinary big picture degrades to a placeholder rather than a killed render, drawing
is budgeted by estimated cost
(layers, filter primitives and reuse through references, scaled by pixels); a style sheet
that applies effects or paint servers by class cannot be bounded that way. Artwork over
budget previews as a placeholder instead of failing the render. The copy is built from an
already validated package, so it is loaded without the compressed-input limit it may now
exceed. Source bytes remain immutable; edits commit a new revision only after serialization
and package checks succeed. A failed edit leaves the last good revision intact.
A draft opened from a chat attachment, project file or skill template retains its pinned
source reference; publication checks that source is still authorized before delivery. A
skill's master or logo is opened by the `skill:` reference `read_skill_file` returns, at the
revision the answer was offered. In desktop
Work a deck or picture on the computer arrives through `import_local_file` as a working file
owned by `local`: accepted as `sourceRef` or an image, never as `workingRef`, which names only
a presentation draft.

Every operation declares the package parts it may change or add, and results are
compared byte for byte against the last verified package: anything else rewritten,
removed or added fails the batch. Consecutive in-memory operations share one open deck
and one save and check, with their allowances combined; saving per operation made a
40-change batch on an 18 MB deck take 11 s instead of 0.4 s. An operation that reads or
rewrites parts directly (pictures, templates, chart data) saves the pending ones first,
and one that adds a slide saves at once, since its ID exists only once saved. Text, tables, shapes and backgrounds touch only their slide. A chart adds
its chart part and embedded workbook; `updateChart` may rewrite only that chart's parts.
`setTheme` rewrites only the first master's theme, and so changes every slide using it.
Picture replacement allocates a new media relationship on its own slide, layout or
master, so another picture, slide or layout sharing the original part is not changed.
Duplicating a slide copies its chart, workbook and notes into parts of its own; slides
with comments or embedded objects are not duplicated. Unsupported package structures must
fail explicitly rather than silently altering untouched parts.

Office Kit writes notes slides without the notes master PowerPoint requires, so
`setNotes` and slide duplication link every notes slide to one, creating it with its own
theme copy when the deck has none. New decks start from Office Kit's blank package with its 4:3 master
geometry rewritten to PowerPoint's 16:9 defaults and three layouts added (Title Only,
Section Header, Two Content); opened files are never templated. A template-based deck
must open the source, not create a blank package and reuse its foreign layout IDs.
`setSlideLayout` only rebinds a slide while preserving its shapes; it does not instantiate
missing placeholders. Replacing examples means adding fresh slides from the chosen
layouts, then bulk-removing the originals, never guessing that a rebind resets content.

Colours may name a theme slot (`accent1`, `dark2`…) as well as `#RRGGBB`. Text,
shapes and tables write the slot, so they follow the deck's palette in PowerPoint; charts
and raw XML need a concrete value, taken from the deck's own theme. Tables are styled
cell by cell rather than by a built-in table style, because the previewer ignores table
style IDs; "no borders" draws each edge in its cell's fill, since a missing line previews
as grey. The text audit measures line widths and ascent/descent extents against its
computed text frame, not whether Office clips glyphs. It keeps an 8 px reporting tolerance;
that threshold does not establish that smaller overruns are safe. Insets, inherited
formatting, font substitution and autofit can differ from Office. The library's
`approximate` flag reports measurement fallback, not whether the original font was used.
This is not complete coverage of tables or grouped content.

## Feedback, previews and the transcript

Overview reads include every slide ID in order, so removing example slides does not
require reading their content page by page. The compact layout catalog includes canonical
text targets, their counts and explicit bounds in points (null when inherited). Models
choose layouts here rather than opening each one; template shape IDs never masquerade
as slide handles. Catalog pages hold
100 layouts (`nextLayoutOffset`), and each layout lists up to 12 targets with an omitted
count; a focused template read recovers the rest. Slide summaries and edit results
include up to 12 actual text-shape handles with short text samples and omitted counts.
Overview pages, focused slide reads and edit results also expose associated-template
candidates from the relevant slides' actual layouts and their related masters, never
unused catalog entries. These are non-placeholder text and pictures, not whole groups
or slide-local handles. Each exact `templateId` + `shapeId` pair targets its owner;
editing it can affect every slide using that owner. Owners are deduplicated and carry
full-deck affected-slide counts, with one aggregate budget of 24 candidates across 12
owners. Counts and omissions are explicit; slide `layoutId`/`masterId` fields identify
owners for focused recovery. Names and text samples are limited to 100 characters.
Explicit hidden and ancestor-hidden flags and slide/layout `showMasterSp` values are
metadata, not proof of effective visibility. Logos and footers are not automatically
unwanted. Focused template inspection still pages the full shape list.

Each edit snapshots the already-open input's numeric audit before mutation, unless every
operation is one that cannot change how text fits (moving, removing or annotating slides,
pictures, lines, charts, fills), in which case neither audit runs. Final findings on
changed slides match by slide ID, uniquely resolved shape ID and direction, not slide
position or the first matching name. Duplicate names stay unmatched. Findings are `new`,
`increased` (at least 8 px), `existing` or `uncompared`. Slides the batch created are
always `uncompared`: Office Kit reuses a removed slide's part name, and can reuse its ID,
so neither proves a slide existed before. Before/after point measurements accompany comparisons; a null before value
means no matched reported measurement, not a measured zero. New/increased and unmatched
findings precede existing ones, descending by measured overrun within each group. Only
12 details are returned, with total, class and omitted counts computed before the cap.
That advice (inspect changed or unmatched findings visually; existing measurements alone
do not justify another corrective edit; a readable preview is no native fit guarantee)
lives in the tool descriptions, sent once, and the edit message changes only when there
are new, increased or uncompared findings. Stable guidance and limits likewise stay out of
results, which omit empty template candidates, a zero audit summary and master flags a
part does not set. Neither the full audit nor associated-template payload is stored in
durable activity summaries.

An inspection computes only what its caller returns: every slide's identity, summaries for
the page or selection, shapes for selected slides, template candidates for those slides'
owners, and the catalog only for an overview; a preview asks for identities alone. An edit
describes the revision it last verified instead of opening its output again. Focused slide
or template reads omit the unrelated overview, catalog, theme and fonts.
Shapes page in groups of 25 through `nextShapeOffset`; multi-slide reads require a
single-slide follow-up to page deeper. Read limits are explicit, and none of these
structural reads claims to have checked appearance. Construction guidance stays at
about 3–5 slides per atomic edit call so feedback arrives before a whole deck is built.

Rendered PNGs for the model are ephemeral next-round feedback, not answer attachments
or persistent tool results. The authenticated viewer renders one slide at a time from an
attachment or immutable project-file version; every request checks current access. The
preview is approximate: renderer differences and missing fonts can diverge from Microsoft
PowerPoint. The original PPTX remains a download, and editing it does not flatten it into
images.

## Fonts

The renderer ships metric equivalents of Calibri, Cambria, Arial, Times New Roman and
Courier New and substitutes one of them for every other family. Admins can upload
TrueType or OpenType faces in the Office files section of Admin → Tools, whose switch (the
`office_files` tools row, read per attempt) decides whether chats are offered the
presentation and [spreadsheet](spreadsheets.md) tools at all; previews of existing files work either way;
`PresentationProcessor` attaches them to every render, so previews and the model's own
slide images draw them. Office Kit's preview
package is patched (`patches/@office-kit__pptx-preview@0.11.0.patch`) with
`setFamilyResolver`, because its substitution is internal and runs on every text path.
The resolver is module state in a worker that outlives its tasks, so each task sets it for
its own faces and the worker clears it when the task ends.

A face's bytes live in its `presentation_fonts` row, not the blob store: blobs belong to a
user, and a shared font must outlive the admin who uploaded it. Renders need file paths,
so faces are written once per content hash to a temporary cache, checked on use and
rewritten when the system has cleaned it. An upload is accepted only after a pool worker
has drawn a sample with it, so a broken font cannot take every preview down; a font that
hangs or crashes the renderer costs that one worker. Before that, `readFontFile` measures
the outlines rather than trusting the font's declared maxima: resolved points per glyph,
composite depth and parts, and per-glyph CFF charstring size are bounded, and CFF2 is
refused. With deck text already bounded, that caps what drawing text can cost; CFF
subroutine calls can still repeat work, which only the kill timeout bounds.

A [skill](skills.md) may carry `.ttf` and `.otf` faces. Once an answer has loaded the
skill, its faces join that answer's renders and edits and its list of usable families,
never the uploaded catalogue. Each is checked once per content hash like an upload, but
entirely inside a worker process, since any skill author can supply one; a face that fails
is left out rather than failing the render.

Free Google families are the third source: a curated catalogue (`google-fonts.ts`, about
forty OFL and Apache families) that the edit tool's description lists once, beside the
Office five, so the model knows them before a deck's first edit. Uploaded families are
named in the fixed system prefix when deck tools are offered, and every result's
`availableFonts` lists what is installed now. An edit naming a catalogue family it lacks
fetches it first: the CSS2 API answers a non-browser client with static TrueType faces per
weight and style, only `fonts.googleapis.com` and `fonts.gstatic.com` are contacted, no
redirect is followed, and a face must call itself by the catalogue's name and draw in a
worker trial render, as an upload must. A failure is
remembered for ten minutes, so an offline server refuses that font quickly. The model may
name only bundled, uploaded, loaded-skill or catalogue families; others are refused with
the list. A live probe (`PROBE_GOOGLE_FONTS=1`) checks the catalogue against Google.

Fetched faces sit in `presentation_fonts` beside uploads, marked `google`, and are a cache:
an edit touches `last_used_at` (at most daily), and a sweep drops those unused for fourteen
days by the database clock; the next use fetches again. Their tmpdir files are left for the
system to clean. They count against no upload quota and are not listed to admins. For one
family and style an upload wins, then a skill's face, then Google's, and an upload owns its
whole family, so a deck never mixes an admin's Regular with Google's Bold. Every face
handed to the renderer is opened for each slide and becomes a glyph fallback, so a job
gets only the faces its deck and operations name (`font-usage.ts`). A render that meets a
catalogue family with no face reports it, and the processor fetches it in the background:
that preview draws a substitute, the next the font.

A deck carries the fonts it uses. Each edit, after its last save, embeds them as one step
under the preservation check (`font-embedding.ts`): uncompressed EOT parts named
`ppt/fonts/chat-<hash>-<style>.fntdata`, the presentation's `embeddedFontLst`,
`embedTrueTypeFonts` on and `saveSubsetFonts` off, so recipients can edit with them. Only
parts under our names are replaced or removed; a font a deck already embedded is kept byte
for byte and its family not re-embedded. Office families are never embedded, since the
faces held for them are metric substitutes. Google faces embed (their licences allow it);
an upload only when an admin turns it on and its `fsType` is installable or editable
TrueType, since a brand licence may forbid documents carrying it; skill faces never. A
deck the fonts would push past the package limit is kept without them, and the result
names them. PowerPoint on Windows and Mac honours embedded fonts; Google Slides has the
Google families natively; Keynote and LibreOffice substitute. Fonts are never subset or
altered, which some OFL reserved-name terms would forbid.

A run of calls on one draft renders as one step of the answer's work line. Prose the
model writes between rounds splits a draft into several such steps, so each says what its
own calls did; only the newest is live. A final unpublished file is labeled a draft; tool
activity alone does not prove whether its durable checkpoint was saved. A publish is the
last step of its run, and the delivered file a part of its own after the work line. The live row names only the current action; streamed
edit arguments show “Writing changes” until the decoded call replaces that marker.
Terminal events clear unfinished markers. The expanded rail labels structural inspection
as “Read” and rendered feedback as “Checked appearance”, not two kinds of “looking”.
Creation, editing and checking stay short rather than displaying operation counts as one
sentence. A recovered tool error is marked in the step list, never announced on a line. Persisted rows, the stream and the reload projection share
`presentationActivitySummary`, which keeps outcomes, counts and a kind-derived change
summary for the model, never operation payloads.

Native Microsoft PowerPoint compatibility remains a separate release gate. Synthetic
fixtures and the packaged-worker smoke tests on macOS and Linux Docker do not prove
that every supported edit opens without repair prompts or matches PowerPoint reference
rendering. A Linux build smoke test verifies native loading and rendering inside the
build image, not a live production server or Office fidelity.
