# Conversation documents

Conversation documents are editable Markdown artifacts owned by one conversation. They are separate from knowledge documents: they are working material for a chat, not indexed source material.

## Storage and transcript boundary

- `conversation_documents` keeps one current row per document. `revision` is a monotonic concurrency token advanced by every write, including source edits and task toggles; it is not version history. Authorization requires both the owning conversation and the person's [document grant](feature-policy.md); a document owned by another account or unavailable under policy is reported as not found.
- A document records the assistant message that created it. Editing a message before that answer removes the answer and PostgreSQL cascades to its documents. Retrying the creating answer keeps its message id, so the retry transaction explicitly removes its documents before generating again. The confirm dialog names that loss before it happens.
- Document bodies never enter message text, durable tool arguments/results, chunks or compaction summaries. Document tool rows keep only a bounded activity projection such as id, owning conversation, title, revision and outcome. Continuation parts replace tool content with a pointer to application-provided document context.
- Branching copies historical tool rows but never copies canonical document rows. Their references therefore render as inert “From another chat” activity in the branch.

## Model context and writes

- A generation receives a bounded manifest of every conversation document and at most one focused body. The document open in the detail panel supplies the initial focus through `openDocumentId`; an explicit model read or write then becomes the focus for later rounds.
- The focused body is capped independently at 24,000 characters and 200 lines. A truncated entry includes the exact continuation position; `read_chat_document` uses `fromLine` and, for an oversized line, `fromCharacter` so later windows cannot skip source. Other documents contribute metadata only.
- Normal model edits use an exact-match patch. `old` must occur exactly once in the current content under the conversation lock: zero matches returns `no_match`, multiple matches returns `ambiguous`, and one match applies against that current row. The model must reread and choose a larger anchor rather than retrying blindly.
- `expectedRevision` on an exact patch is advisory. A stale read is reported, but a unique current anchor can still land beside a person’s unrelated edit. Full replacement is intentionally rare and requires an exact revision. Creation and every write run the generation guard inside the transaction so Stop, retry, edit and lost ownership can interrupt stale work.
- Tool-call transport accepts an object with omitted keys even when the advertised JSON schema marks them required. The handler, rather than `LanguageModel.streamText`, then returns its bounded invalid-input correction. This is essential for aliases such as `old_string`, which cannot be repaired if Effect rejects the part first.
- Document context is application data, not instructions. Research mode omits conversation documents in the first version.

## Person edits

- The source editor saves the whole document with compare-and-swap after a 450 ms debounce. Controllers serialize writes, preserve keystrokes made after an in-flight acknowledgement, and never force a refetch while flushing source. Before send, structured answer, retry, message edit or branch, every mounted document controller flushes; Stop never waits for an autosave.
- A newer remote revision is adopted when local source is clean. If local source differs, the controller preserves it and shows “Changed while you were editing” with **Keep mine** and **Take theirs**. This is deliberately whole-document reconciliation rather than an automatic text merge.
- Rendered GFM task controls are mapped back to source by ordinal among task-list lines. Streamdown receives rendering-only sanitized marker spans so nested and numbered items retain that ordinal. A tick updates local source immediately and then sends an ordinal patch without a revision precondition, so a concurrent model edit elsewhere can land beside it. If the source is already dirty, the normal serialized save carries the tick instead.
- While the assistant is generating, the panel is read-only. This keeps one person-side source transaction from racing a model write; source is flushed before the generation starts.

## UI ownership

- `DocumentOwner` mounts one controller per known id at conversation level, above the virtualized transcript and outside the replaceable panel body, so closing the panel or opening another detail cannot discard local source.
- A full document card renders at the creating `create_document` tool row, using that row’s persisted message, turn, call and text-offset coordinates just like other tool activity. Later reads and edits are compact rows. A legacy row without its create call falls back inside its creating answer, never below the transcript.
- The panel title is model-owned. Its only actions are an animated Preview/Source switch and Copy; documents are removed by rewinding their creating answer rather than through a panel delete control.
- Preview shares the assistant Markdown renderer and changes only GFM task controls. Markdown still passes through Streamdown’s sanitizer. Copy uses the current local source and never adds content to the transcript.
