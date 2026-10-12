# Files

One rule for every file the app stores: a chat upload, a file a tool or the model returns,
an image in a document, and a project file. Any bytes are kept; the bytes decide what the file is, never the
declared type, and only the kinds we understand are shown or handed to a model.

## Kinds

- `attachmentKind(mediaType)` is derived, never stored. `image` is exactly JPEG, PNG, GIF
  or WebP by signature, the types providers and the preview take. `pdf` is a PDF header.
  `text` is UTF-8 that claims to be text (a known extension, no extension, or a declared
  `text/*`). Everything else is a `file`, an unusual image (`image/heic`, SVG) included.
- `classifyFile` (`attachments/server/validation.ts`) is the one classifier; uploads,
  returned files and project writes all call it. It never refuses: emptiness and size
  are each caller's rule. A `file` is stored with a descriptive type from its name
  (`fileMediaType`), which can never name one of the readable kinds, so a `.png` that does
  not sniff as PNG stays a `file`.
- Deduplication shares bytes, not a resource's classification. Each attachment stores the
  server-validated type for its name and input, including when a project blob already stores
  those bytes as an opaque file. Reads, message and queue listings, and branch copies keep that
  attachment type. Blob hash and size remain authoritative. Knowledge and project versions and
  skill files also retain their own classification rather than changing the shared blob's
  first-writer type. Existing attachments inherit their blob's recorded type on migration,
  because their original validated classification cannot be recovered reliably.
- A `file` is always a download. Every route that serves stored bytes (attachments, project
  versions, knowledge versions, skill files) answers through `fileResponse`
  (`server/file-response.ts`): `nosniff`, a `file` sent as `application/octet-stream` whatever
  its stored type says, and only images and PDFs ever inline. HTML and SVG are active content
  on this origin and must never render there. Only `/api/files` caches, because who may read an
  attachment there never changes while it exists. A route whose access can be revoked caches
  nothing, a document's images included.
  Office files may also be previewed through separate read-only endpoints; the original
  remains a download. See [presentations](presentations.md).

- An attachment has at most one owner: a message, a queued message, a kept working file, or a
  text document it is an image of (`document_images`). The `unclaimed` predicate in
  `attachments/server/repo.ts` reads all four, so an owned upload is never swept, deleted as
  abandoned or claimed again, and every claim takes the blob lock first, since the owner tables
  share no unique index. An owner that cascades away leaves its attachment to the unclaimed
  sweep. Sweeping takes at most ten batches of 100 uploads, each in an independent transaction.
  The cutoff stays fixed and deletion rechecks claims after sorted blob locks, so a large backlog
  makes progress without one large transaction or oversized parameter lists.
  A document's images are claimed attachments, served to that document's readers at
  `/api/documents/:id/images/:attachmentId` without caching, and kept until the document goes,
  even once taken out of its text. Their bytes are the document owner's (the project's owner
  or the chat's), as a project file's are, so they outlive any member who added them and go
  with the document. See [documents](documents.md).
- A message's attachments carry a `kind`: `file`, or `search_image` for an image a ```ui
  block asked for (see [generative UI](generative-ui.md)). A search image belongs to the
  answer for lifetime, retry and branch, but it is page material, not a file of the chat.
  The listings filter it out where they are defined (`listForMessages`,
  `listWithBlobsForMessages`, `listForConversation`), so the model, the answer's file cards,
  tool file names and project saves never see one. A new reader of `message_attachments`
  must choose its kind.

## What the model sees

- Images and PDFs go as bytes when the model takes them, PDFs as extracted text otherwise
  (scanned pages read as an admin chose; see [PDFs](pdf.md)), text as a fenced block. Text
  past `inlineTextCharsFor` (a quarter of the window, at most 60k characters) is inlined as its start and end around a marked cut: a whole large CSV or
  log failed the turn outright. Any text, PDF or Office file linked to the conversation's
  messages stays readable through `read_attachment`, by range or by searching its lines,
  which is also how a file summarized out of history is read again by id. The tool's row
  keeps which file and part were read, never the text.
- An image a person attached is refused for a model without vision, at send and when a
  retry, edit or resume switches to one: the message is about that image. An image an
  answer produced is not: such a model reads `imageStandIn` in its place, a line saying it
  cannot view the image and must not guess at it, so switching models later never strands
  the conversation.
- A `file` goes through `opaqueFileText` (`attachments/server/file-text.ts`): its text when
  `fileText` has a reader for it (Office documents and SVG source today; new formats are added
  there and nowhere else), otherwise a line naming the file, its size and its id, saying it cannot be
  read here and that the model should say so if no tool can take it. Every attached file is
  therefore visible, so the model never guesses at one it cannot open. Bytes are only
  loaded when there is a reader.
- History replay and a tool's shared file follow the same representation. Attachment
  metadata carries the current registered ID and `/api/files/<id>` reference beside the
  bytes or extracted text. Historical assistant metadata stays outside signed replay
  turns and tool pairs, but in the same compaction group. Branches supply cloned IDs
  in that metadata without rewriting signed provider replay.

## References in answers

Explicit Markdown links to `/api/files/<id>` render as inline file tags. Resolution
uses exact IDs from the current conversation's message-linked attachment metadata,
including unloaded history and live generated files. Pending queue files are not
eligible. Labels come from stored metadata, not model prose; missing targets are
inert. The authenticated file endpoint remains the authority for bytes. Bare names,
code and image embeds are not references, and ordinary web links keep the question
before leaving the app, asked with the app's own dialog (`~/ui/link-safety.tsx`, shared by every
`<Streamdown>`). In the desktop app they open as side-panel tabs instead; see
[browser](browser.md).

A branch records attachment aliases from historical IDs to its cloned IDs inside the
clone transaction. Inherited aliases flatten through that clone map and drop targets
outside the copied prefix. This provenance survives source deletion, without changing
message text, offsets, tool payloads or provider replay. Aliases confer no access: a
target must still exist in the branch's attachment projection. Retrying an answer may
remove its target, making old links unavailable rather than opening the source file.

Local Work references have a separate absolute-path address space and read current
bytes on click; see [desktop paths](desktop.md#several-folders-one-absolute-address-space).
The reference renderer shares existing previews, never a new active-content viewer.

## Files into tools

A custom tool declares a file parameter with `fileInput`; see
[custom tools](custom-tools.md#file-inputs). The host resolves what the model passed
within what the sender may read, so a tool never touches storage or permissions. Besides
attachments, project versions and working drafts, a file in a [skill](skills.md) resolves
from its `skill:<revision>/<path>` reference, so a skill can carry a presentation master or
logo that tools open directly.

An answer's attempt owns a bounded working-file workspace in memory. Files returned with
`delivery: "working"` are private revisioned drafts, not delivered files; exact
`working:<id>@<revision>` references let later tools read or replace them. Their type is
classified from the bytes like any stored file. Each working file names its owner (one
custom tool module, the presentation, [spreadsheet](spreadsheets.md) or [Word](word.md) tools, or the
computer), and only its owner may
revise it. An answer may create eight drafts; the kept ones it continues do not count.
Every file a tool on the user's computer returns (an import, a file it read, a browser
screenshot) is a `local` draft too, so other tools can take it and `publish_file` can deliver
it, which (with a screenshot shared as it is taken) is the only way one is ever stored. All but imports are captures: cheap to take
again, so they do not count toward the eight, and when the answer runs out of room the oldest
unpublished capture is dropped, its reference then saying to take it again.
`create_file` lets any chat that can deliver files write a text file (CSV, JSON, Markdown,
HTML, SVG, code) whole: a one-off draft, published at once through the same path and budget.
`publish_file` seals an exact revision and registers one attachment; a second publish of a
file already being published is refused, and one already published names its attachment. A
custom tool's `delivery: "publish"` and a `browser_snapshot` with `share` register their file
during that call through the same fenced path, one `deliverFile` in the stream for all three. Publishing alone consumes the answer's five-file, 40 MiB output budget. Every
chat has one 128 tool-round ceiling, a guard against runaway loops rather than a budget,
then a final tools-off response.

An unpublished draft outlives its answer, so Stop, an error or a question never throws away
work a later answer can continue. After each tool round, and when the answer ends however it
ends, the latest revision of every changed Office or custom draft is saved to
`conversation_working_files` under the generation fence; an attempt that was superseded
saves nothing, a failed save is retried at the next boundary, and a process lost mid-answer
loses at most its last round. A file has one row per answer that changed or
published it, holding only that answer's latest revision, and the newest answer's row is the
file's state. Publishing writes the publishing answer's row, with no bytes, in the
registration's own transaction. Retrying, editing or rewinding an answer removes its rows
with its other files, which restores exactly what the answer started from: a draft it
published is offered again, and a draft it revised is back at the earlier revision.
[Resuming](resume.md) an answer keeps its rows, and its next keep updates the same row.

A later answer is offered the newest eight current drafts whose editor it is also offered,
loads bytes only when a tool touches them, and re-checks that the sender can still read the
chat or project file a draft was opened from before loading or publishing it. That check
reads metadata only, so a project version stays publishable after newer versions land.
References reach the model in one trailing notice fixed for the whole answer, since it sits
ahead of the answer's own rounds in the cached prompt; names in it are quoted as data. Files
from the computer are never kept: they are the person's local files or pages, re-readable,
and a kept draft opened from one drops that source. A later answer sees a capture only once
published, as the answer's attachment in history; otherwise it takes a new one, since a page
changes.

The bytes are an attachment the row claims, owned through its answer like the answer's own
attachments, so releasing an answer's files releases its drafts and deleting the chat
releases them all at once. A row that cascades away any other way leaves its attachment
unclaimed for the attachment sweep. Rows unchanged for 14 days are dropped in batches by the
service's own sweep, judged by the database clock; open tabs are told. A branch copies none.
Rendering/model feedback is ephemeral and does not use an attachment slot. In the transcript
a publish has no row of its own: it is the last step of the run of calls on the draft it
delivered, and the delivered file renders as that activity's result, in a branch too, since
a branch points copied tool rows at its own file copies. The model briefly acknowledges the
delivery without duplicating the file card or its contents, unless the reader asks for
detail.

## Office families

PowerPoint, Excel and Word are one lifecycle with three formats, so what they share is written
once and each family supplies only its format. `modules/office/families.ts` is the registry:
extension, media type, tool names, envelope, activity summary and wording per family. The
stream, the reload projection, working-file owners (and the `owner` column's enum), desktop
imports and previews iterate it, so a family missing from one of them is not possible. Tables
that do differ per family (transcript wording, preview components, server tool preparation in
`office/server/families.ts`) are records keyed by family, which the compiler makes complete.
A new format is its module plus one entry in each of those.

`office/server/tool-kit.ts` is what every family's tools share: one error shape, source
resolution by reference and fingerprint, the create-or-open start of an edit and saving a
draft revision, with messages worded per family. `office/operations.ts` is the operation
engine behind each family's table (below); a family adds only its own field kinds and the
checks that span fields. The engine also runs inside worker processes, which resolve no `~`
alias, so it and the tables import relatively.

See [presentations](presentations.md) for the format-specific editing boundary.
