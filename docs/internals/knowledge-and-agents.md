# Agents and knowledge

Two facts drive most of the design here. An agent is a saved chat configuration, never a
permission: attaching one changes what a conversation runs with, not what a user is allowed to
do. Collections are selected per message, like attached files, not per conversation: the
composer sends the current standalone list with every send and clears it, independent of
whatever agent the conversation is associated with.

## Agents

- The first message installs a fixed association in `conversation_agents`, not a config
  snapshot: no swap, reselect or removal afterward. No row means plain chat; a null agent FK is
  a deletion tombstone. `AgentNotAvailable` blocks new attempts on a deleted/inaccessible agent
  while history stays readable.
- Every new attempt (send, retry, edit, structured answer, branches)
  resolves the current revision/dependencies through ACL-aware `AgentRepo.get` inside the
  attempt transaction, before any destructive reset. `message_generation_config` then captures
  that private `resolvedAgent` provenance plus original `standaloneCollectionIds` separately;
  future attempts reuse those inputs, never prior dependencies, and branches copy them as
  history, not future defaults.
- Recipient projections never expose instructions or private execution records.
- `update_plan` is an agent preference (`planEnabled`), tool-capable models only. Each call
  replaces the whole checklist, never a revision history, and a completed step is only the
  model's own claim, not verified coverage. Research keeps a separate internal plan.

## Conversational drafts

- A draft is an ordinary conversation’s working resource, not an installed resource or a
  special chat mode. One store serves both kinds: `conversation_drafts` holds `kind`
  ('agent' or 'schedule') plus an opaque `settings` jsonb the per-kind service decodes; the
  generic `DraftService` (`src/modules/drafts`) owns idempotent open, CAS patch, discard and
  the `draft.changed` sync event, parameterized by a small per-kind config (`kind`, `empty`,
  blank-reuse baseline, optional target snapshot/check). `save` and `reload` stay per-kind,
  because validating and writing the live resource is exactly what differs. The client is
  generic the same way: `useDraft` (form, 450 ms debounced CAS queue, field reconciliation)
  and `DraftOwner` (conversation-level sessions, the panel, one context per kind) take a
  `DraftClient`/`DraftKindUi` describing the shape, the server functions with their outcomes
  folded to `target_changed`/`target_unavailable`, the field labels and the copy; the agent
  and schedule modules are thin registrations of those. Draft tools
  (`draft_agent`/`draft_schedule` and kin) lazily create a draft, or snapshot an owned
  target, under the current generation fence. A conversation holds as many drafts as
  resources being prepared, each with its own id: opening the same target twice returns the
  draft already holding it, and an untargeted call reuses an empty unedited draft, so a
  repeated call cannot litter the chat. Anything else is a second resource and gets its own
  draft — reusing one draft for a second target is how a save silently overwrote the first.
  A draft belongs to the answer whose tool call opened it (`created_by_message_id`, cascading),
  exactly like a conversation document: rewinding that answer by retry or edit removes it, and
  the confirmation names it first. Otherwise only the user discards a draft, from the panel. A
  draft that outlived its answer dangled under the transcript and stayed in the model's
  trailing data with nothing introducing it. The shortcut only seeds an unsent request;
  see [UI ownership](ui.md#chat-specific-pieces).
- `draftId` is optional on the update/read tools while a chat has one draft of that kind,
  and required once it has several; omitting it then returns `invalid` naming each draft.
  The draft a tool last wrote rides in the trailing data in full, the rest as id, name,
  revision and saved state, so long instructions in several drafts cannot inflate every later
  request.
- The fixed prefix carries only a one-line pointer at the authoring skills; each kind's long
  authoring policy rides in its trailing draft data and appears only once a draft of that
  kind exists, so ordinary chats on small models do not pay for it every turn.
- Target instructions and selected-resource descriptions are lower-authority editing data,
  never the conversation’s persona, installed dependencies or automatic user-memory facts.
  Option discovery uses accessible metadata (including manual-only skills), not resource
  bodies. The user's own chat models (the composer picker's list, current one marked) ride
  in the trailing draft data so a model preference needs no discovery call; ids outside that
  list still fail at Save. The main assistant refreshes canonical settings before every call, rebuilds and
  budgets the actual trailing context, and measures its advertised tool schemas: that
  measurement replaces the flat overhead guess only when it is larger, never on top of it.
  Compaction cannot replace the current draft with an older transcript copy.
- The draft revision and the saved resource's revision answer different questions. Patches use
  draft compare-and-swap; omitted fields survive and arrays/instructions are whole conflict
  units. Only explicit Create/Save validates and writes the live resource, atomically with the
  accepted draft revision’s receipt. Repeating that save returns its receipt; later draft
  revisions need new approval and keep the same target. Normalization affects the saved resource,
  never unseen settings under an already-reviewed draft revision.
- Only Save or explicit Reload advances the target baseline. A manual edit or another draft
  saving first produces a recoverable conflict. Target identity survives deletion: neither a
  deleted target nor a stale receipt can silently create a replacement. Postcommit sync failure
  cannot turn a committed write into a reported failure.
- Public tool rows, SSE, continuation and branch snapshots share the explicit per-kind
  projector (`agent-draft`, `schedule-draft`): status, originating conversation, revision and
  changed field names only. Arguments, settings, options and driver errors never enter those
  projections; authorized private queries supply the editor/widget. A reference carries both
  the draft id and its owning conversation: the id addresses the controller, the conversation
  is what keeps a branch-copied row inert. A call that did not update the draft stores the
  handler's own sentence (schema paths, fixed messages) on the tool row for debugging; the
  transcript shows only the label. Branches copy historical references, not draft state or save
  authority.

## Sharing and access

- Feature access is additive across groups, separate from the ACL on each resource. The
  recipient needs Use and the creator still needs Create, even for an instance-wide grant;
  losing Create, or a ban, suspends all of that person's resources without deleting them. See
  [feature access](feature-policy.md). An agent is never itself a permission.
- Group sharing is per kind: `group_members.share_agents`, `share_knowledge` and
  `share_skills` all default to false, and an owner needs the one matching the resource to
  create a group grant. Allowing one kind never covers another. The sharing transaction holds
  that membership row `FOR SHARE` through insertion so disabling/removal serializes with grants. Admins may share to any group or publish
  instance-wide, but never another owner's resource.
- An agent grant never grants its collections or model — checked separately, and losing a
  selected collection fails the whole turn (`KnowledgeNotAvailable`), never a partial answer.
  An agent's integrations likewise grant nothing: each sender uses their own connection, and
  a sender without one is simply not offered the tools.
  Agent instructions are a system-role `<agent-instructions>` block after application policy
  and memory, behind one line saying they cannot override that policy and grant nothing.
  Their own closing tag is neutralized; see `system-prompt.ts`.

## Collections and documents

- The composer sends the standalone collection list with every send and clears it on submit;
  an agent's own collections persist across the conversation instead. The server stores what
  each generation actually ran with, so retry/edit never depend on later composer state. A
  collection shows only on the question that added it, never as an activity row on the answer
  (`knowledge_context` still exists underneath for citations/replay).
- Editing a message resends its own selection: the editor is seeded from that message and its
  submitted `skillIds`/`collectionIds` replace the saved standalone set, the same rule
  `searchEnabled` follows. Omitting them keeps the saved selection; retry always does, having
  no submission. A question shows and an edit seeds from `standalone_collection_ids` minus the
  turn's agent's own, never the effective `collection_ids`: reseeding the agent's would rewrite
  what the turn ran with. An edit that changes collections must skip the plain-chat replay
  shortcut in `resolver`, because a new collection set needs a rebuilt manifest.
- Editing is not a mode: an open editor disables nothing, another message's Edit switches to it
  (the abandoned draft goes with its unmounted row), and sending from the composer ends the
  edit. Every path that abandons an edit has to release its uploads, not just forget which
  message was open.
- The composer (`chat-textarea.tsx`) is a Tiptap editor over a plain-text value: one paragraph
  per line, a tag an atom node whose text is what the stored message keeps (`composer-doc.tsx`):
  the typed `@Name` for an integration, a link for a skill or collection (`tags.ts`,
  `[/review](/skills/<id>)`, `[#Contracts](/knowledge/<id>)`). Everything outside it (send, the
  stored message, retry, edit, branch, the model) sees only the string. `/`, `#` and `@` are one
  `@tiptap/suggestion` plugin each, and every pick leaves a tag; the lists keep offering what is
  already added. A value arriving as a prop is compared with the last one the editor emitted;
  only a real outside change (send, seed, a queued message opened for editing) replaces the
  document, outside undo, so an echo never resets the caret.
- For skills and collections the selection (`skillIds`, the context selection) still decides
  what loads; the tags mirror it, kept in step by `useTagSync` in `ChatInput`, shared by the
  composer and the edit box. Deleting a tag deselects it, a + menu pick puts its tag at the
  caret, unticking in the picker removes its tags, and a tag that appears unselected (a paste,
  an edit whose message kept the words) selects it if it is one this person can use. An agent is one
  bundle: a chosen agent is one chip and its collections and skills get none. The composer's
  selection holds only the person's collections; the agent's are not offered and count only
  toward the per-message limit, which blocks a send past it. A pick the agent also brings is
  kept but hidden while that agent is chosen. A sent message shows as chips only the person's
  picks its agent did not bring and its text does not name.

- File classification belongs to each validated resource, not to the first filename that
  stored its bytes. Knowledge publication preserves the supplied media type while using the
  locked blob’s size and identity. Byte deduplication with an opaque attachment therefore
  cannot turn a text document opaque or stop its extraction.
- A collection can also mirror part of a connected service through a knowledge source.
  Source provenance and note versions commit together under the source’s live lease fence,
  including identical-content metadata updates. These documents are read-only here.
  The source’s lifecycle, ownership and sharing consequence are in
  [integrations](integrations.md#knowledge-sources).

## Retrieval and direct context

- Knowledge mode is decided twice: metadata at turn time (`fitsDirectContext`) and the rendered
  prompt at dispatch (`prepareKnowledgeContext`), which may downgrade "context" to retrieval but
  never the reverse. Selection authorization failures are sticky terminal errors, even after the
  final provider call, and never become recoverable failed tool results.
- Direct context includes every selected document or none, sits after retained history in
  protected trailing position, and cites through the `knowledge_context` activity. Retrieval
  offers `list_knowledge_documents`, `search_knowledge`, `read_knowledge_document` (shared 64 operations and 3 permits,
  under the chat's one tool-round ceiling), steered to search first since a search already returns the references a
  read needs. A search hit is a bounded excerpt (`searchExcerptChars`, 800) so a multi-query
  batch keeps all its hits instead of spending the cap on the first few whole chunks.
- Document sources are namespaced by `kind` (`document` vs. `web`) so citation indexes never
  collide and documents grant no web URL authority; the host turn and an investigation project results
  through `projectKnowledgeToolResult`. Range reads walk 4,096-code-point blocks inside
  PostgreSQL and reject starts inside surrogate pairs, so continuation offsets stay exact.

## Embeddings and vectors

- OpenRouter's default `GET /models` is text-generation only — embedding models appear only
  under `?output_modalities=embeddings`, so `fetchCatalog` fetches both views and merges by id.
  No catalog field carries an embedding model's width, so the admin's Detect button sends a real
  `POST /embeddings` through `probeEmbeddingDimensions` and reads it back — the only honest
  source. A same-dimension model switch asks whether existing vectors stay comparable; "keep" is
  the admin's explicit claim, never inferred from name or dimension count.
- The embedding column is bare `vector`; search is an exact cosine scan per space, deliberately
  with no HNSW/IVFFlat index — that's what lets 3,072–4,096-dim models work, since pgvector
  indexes only up to 2,000 dims though it stores up to 16,000 (app caps at 8,192). If ANN ever
  becomes necessary: `halfvec` (indexable to 4,000, any model) or Matryoshka truncation via
  `dimensions`, only for models trained for it (not Qwen3-Embedding) — a per-space decision.
- The approved width (`expectedDimensions`) verifies responses but is never sent as a
  `dimensions` request parameter, since that asks the provider to truncate and non-Matryoshka
  models may reject it.
- Integration suites must start `POSTGRES_IMAGE` (pinned pgvector), never `postgres:17-alpine`:
  the knowledge migrations create `vector` columns and fail on the stock image with a bare
  error that names no cause.

## Indexing and repair

- Indexing publishes a content-free `knowledge.index.changed` event, not a policy change. The
  client coalesces these into knowledge-only refreshes and schedules one follow-up for events
  arriving meanwhile; first SSE open also reconciles knowledge, since completion can land
  between the initial fetch and subscription.
- Workers subscribe before the startup drain, then sleep until a stage-specific committed
  work notification. Enqueue, extraction completion, retry, rebuild/reindex and embedding
  configuration/provider/model changes wake the relevant stage. One pending wake survives
  a concurrent drain; claims still use their existing fences and `SKIP LOCKED`.
  Reconnect also drains. A thirty-second recovery scan remains because lease expiry needs
  no database write to make a job claimable; one process-scoped sweep fails exhausted jobs.
  Unexpected step failures retry after five seconds, independently of idle recovery.
- Embedding provider failures are classified by the gateway, which keeps the status and any
  `Retry-After`. A rate limit belongs to the key, not the page: the job goes back without
  spending an attempt and the whole embedding worker pauses (the provider's figure, else 5 s
  doubling to 5 min, jittered). A paused worker reports no work rather than sleeping, so the
  pause lasts until the next recovery tick or wake after it. Provider faults, network errors
  and a rejected key are retried per job with a growing delay (`not_before`, judged by the
  database clock); a request the provider rejects as invalid fails at once.
  See [notification recovery](sync.md).
- Owners see one repair, Rebuild index (`rebuildIndex`): re-extract stale documents, then
  re-embed only versions not indexed for the current model, safe to run on any doubt.
  `rebuildContent`/`reindex` stay separate services internally — don't resurface them as
  separate owner-facing actions. Admin Rebuild all queues only stale work, per collection as
  each owner.
- `pipelineFingerprint` (parser + `CHUNKER_REVISION`) is recorded on every published version, so
  a pipeline improvement never rewrites one: `rebuildContent` queues a new version only where
  the current pipeline couldn't have produced it, and keeps the old one readable/citable until
  the new one is ready. Identical replacement saves reuse the latest version. A PDF's parser
  part names its scan engine, and an incomplete scan reading never counts as current; see
  [PDFs](pdf.md#fingerprints-and-caches).
- Postgres refuses NUL (U+0000) in `text`; pdf.js emits it for private-use glyphs.
  `stripControlCharacters` guards every extraction — without it `completeExtraction` dies and
  the row sits in `extracting` until the lease lapses, so the owner sees a "timeout" that is
  really three failed attempts. A scanned page that was not read is disclosed, not fatal
  (`truncated: true` refuses direct context and tells the model coverage is partial); a PDF with
  nothing readable at all still fails, saying why its scans were not read. Reading scans renews
  the extraction lease and waits out a reader's rate limit; see [PDFs](pdf.md#waiting-for-it).
