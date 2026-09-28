# Files

One rule for every file the app stores: a chat upload, a file a tool or the model returns,
and a project file. Any bytes are kept; the bytes decide what the file is, never the
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
- A `file` is always a download: `/api/files` and `/api/project-files` send
  `Content-Disposition: attachment` and `nosniff`, and `/api/files` sends a `file` as
  `application/octet-stream` whatever its stored type says. HTML and SVG are active content
  on this origin and must never render there. An authorized PPTX may also be rendered as
  approximate PNG slides through a separate read-only preview endpoint; the original remains
  a download. See [presentations](presentations.md).

## What the model sees

- Images and PDFs go as bytes when the model takes them, PDFs as extracted text otherwise,
  text as a fenced block: unchanged.
- An image a person attached is refused for a model without vision, at send and when a
  retry, edit or resume switches to one: the message is about that image. An image an
  answer produced is not: such a model reads `imageStandIn` in its place, a line saying it
  cannot view the image and must not guess at it, so switching models later never strands
  the conversation.
- A `file` goes through `opaqueFileText` (`attachments/server/file-text.ts`): its text when
  `fileText` has a reader for it (Office documents today; new formats are added there and
  nowhere else), otherwise a line naming the file, its size and its id, saying it cannot be
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
code and image embeds are not references, and ordinary web links retain Streamdown's
link confirmation.

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
within what the sender may read, so a tool never touches storage or permissions.

An answer's attempt owns a bounded working-file workspace in memory. Files returned with
`delivery: "working"` are private revisioned drafts, not delivered files; exact
`working:<id>@<revision>` references let later tools read or replace them. Their type is
classified from the bytes like any stored file. Each working file names its owner (one
custom tool module, the presentation tools, or a desktop import), and only its owner may
revise it. An answer may create eight drafts; the kept ones it continues do not count.
`publish_file` seals an exact revision and registers one attachment; a second publish of a
file already being published is refused, and one already published names its attachment. A
custom tool's `delivery: "publish"` registers its output during that call through the same
fenced path. Publishing alone consumes the answer's five-file, 40 MiB output budget. Every
chat has one 128 tool-round ceiling, a guard against runaway loops rather than a budget,
then a final tools-off response.

An unpublished draft outlives its answer, so Stop, an error or a question never throws away
work a later answer can continue. After each tool round, and when the answer ends however it
ends, the latest revision of every changed presentation or custom draft is saved to
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
ahead of the answer's own rounds in the cached prompt; names in it are quoted as data. Imports
from the computer are never kept: they are the person's local files, re-importable, and a
kept draft opened from one drops that source.

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
See [presentations](presentations.md) for the format-specific editing boundary.
