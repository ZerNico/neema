# Word files

Word editing follows the [presentation](presentations.md) and [spreadsheet](spreadsheets.md)
pattern: fixed, trusted operations in the Node app, no model-authored code. The model
inspects an authorized `.docx`, edits a private working draft revision by revision, and
publishes it through the shared [file lifecycle](files.md#files-into-tools). Kept drafts,
Resume, skill templates and desktop imports work as for decks and workbooks. The family is
`word`, never "document": that word means the live Markdown [documents](documents.md).

## Blocks, numbered per revision

The model addresses the body as blocks, its top-level paragraphs and tables, numbered from 0
as `inspect_word_file` lists them. A number inside that revision means its block, resolved to
the block itself, so an insert early in a batch never shifts what a later operation touches,
and a block removed earlier in the call is an error, not a silent retarget. A number past the
revision's end counts on through what the call has added so far: a model writing a new document
counts that way, and failing it made the first call of nearly every new document fail. The
result says where inserted content landed, and the next revision is inspected afresh. Text-based operations (`replaceText`) need no numbers at all,
which is how templates with `{{placeholders}}` are filled.

Operations come from one table in `modules/word/operations.ts`, as for the other families:
replace text (body, table cells, headers and footers, also across runs), rewrite, insert or remove
paragraphs, tables, pictures, page breaks and a table of contents, footnotes, headers and
footers, title and page layout. New text takes inline `**bold**`, `*italic*`, `` `code` `` and
`[links](https://…)`; a link must be http, https or mailto. Styles are found by Word's built-in names, which are
the same in every language, so a German template's headings are its own `Überschrift 1`,
not a second English style. A batch commits atomically, and one that would add a problem
the validator reports as an error is refused; problems the file already had are tolerated.

## Fields, headers and pictures

A table of contents is a field Word computes: it lists paragraphs by outline level, which the
built-in heading styles carry, so a paragraph that only looks like a heading is left out; the
tool's description tells the model to use heading styles. The file stores a placeholder;
`updateFields` in `settings.xml`, which the library doesn't model and is written into the saved
package, has Word fill it in on open (Word asks first). The preview lists the headings it will find instead.

The library adds header and footer references without removing old ones, and after the page
size, where the schema puts them first; the adapter replaces the default one and reorders. In a
one-section document the old part goes too; with more sections it is only unlinked, since an
earlier section may use it. Page numbers and appended lines go into the existing part instead,
so a template's logo stays; the library doesn't model these parts, so that is XML appended in
the part's own namespace prefix. Page numbers are one setting rather than an addition: setting
them removes every top-level paragraph holding a PAGE field (Word's simple field too) from the
default header and footer first, so asking again restyles or moves them instead of stacking a
second set. Paragraphs are found by counting nesting, since a logo's text box holds paragraphs of
its own.

Word reads the properties of a style, a paragraph and a section only in the schema's fixed
order, and treats anything else as damage. Restyling (`setStyle` changes a style's definition, so
every paragraph using it follows) and page settings therefore replace one property element and
re-sort the rest by that order. Styles are applied by built-in key or by any paragraph style name
the document defines, which inspection lists.

A picture is resolved by the tool within what the sender may read, and reaches the worker as
bytes; only what sniffs as PNG or JPEG is placed, sized from its own pixels. The preview sends
pictures as bounded `data:` URLs of those two types, and the client draws nothing else.

## Containment

`@office-kit/docx` (MIT, pre-1.0, pinned exact) has no limits of its own. Before it sees a
byte, every part is inflated once from its local header and measured, since a zip's declared
sizes can lie; parts, total and per-part size are bounded. The parser itself reads the
central directory and allocates the sizes declared there, so that listing must name the same
parts and declare sizes within the same bounds, or the file is refused. Macro projects, ActiveX controls and embedded objects
are refused, as for decks. Parsing and editing run in killable worker processes of their own,
as [jobs](presentations.md#jobs), so what remains of a hostile file ends at the timeout.

## Previews

`/api/word/:kind/:id` returns the document as structured data, roles, formatted runs and
table cells, bounded in blocks and characters. The client lays it out with plain elements;
nothing from the file is ever markup. Images are counted, not drawn. It shares the access
check and content-hash cache with the other Office previews (`server/office-preview.ts`).
