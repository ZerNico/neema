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
  on this origin and must never render there. The preview dialog offers a download instead.

## What the model sees

- Images and PDFs go as bytes when the model takes them, PDFs as extracted text otherwise,
  text as a fenced block: unchanged.
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
