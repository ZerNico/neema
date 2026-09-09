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
- Every new attempt (send, retry, edit, structured answer, research continuation, branches)
  resolves the current revision/dependencies through ACL-aware `AgentRepo.get` inside the
  attempt transaction, before any destructive reset. `message_generation_config` then captures
  that private `resolvedAgent` provenance plus original `standaloneCollectionIds` separately;
  future attempts reuse those inputs, never prior dependencies, and branches copy them as
  history, not future defaults.
- `AgentBar` refreshes safe live identity/dependencies on resource change without clobbering
  standalone drafts already made. Recipient projections never expose instructions or private
  execution records.
- `update_plan` is an agent preference (`planEnabled`), tool-capable models only. Each call
  replaces the whole checklist, never a revision history, and a completed step is only the
  model's own claim, not verified coverage. Research keeps a separate internal plan.

## Sharing and access

- `group_members.can_share` defaults to false; an owner needs it enabled to create a group
  grant. The sharing transaction holds that membership row `FOR SHARE` through insertion so
  disabling/removal serializes with grants. Admins may share to any group or publish
  instance-wide, but never another owner's resource.
- An agent grant never grants its collections or model — checked separately, and losing a
  selected collection fails the whole turn (`KnowledgeNotAvailable`), never a partial answer.
  Agent instructions enter the prompt as a user-role block after application policies.

## Collections and documents

- The composer sends the standalone collection list with every send and clears it on submit;
  an agent's own collections persist across the conversation instead. The server stores what
  each generation actually ran with, so retry/edit never depend on later composer state. A
  collection shows only on the question that added it, never as an activity row on the answer
  (`knowledge_context` still exists underneath for citations/replay).
- Editing a message resends its own selection: the editor is seeded from that message and its
  submitted `skillIds`/`collectionIds` replace the saved standalone set, the same rule
  `searchEnabled` follows. Omitting them keeps the saved selection; retry always does, having
  no submission. Seed from the standalone remainder, never `message.collectionIds` — that is
  the effective union, and reseeding the agent's own collections as standalone would rewrite
  what the turn ran with. An edit that changes collections must skip the plain-chat replay
  shortcut in `resolver`, because a new collection set needs a rebuilt manifest.
- Editing is not a mode: an open editor disables nothing, another message's Edit switches to it
  (the abandoned draft goes with its unmounted row), and sending from the composer ends the
  edit. Every path that abandons an edit has to release its uploads, not just forget which
  message was open.
- Composer mention type-ahead (`useTextareaMentions`, `src/ui/textarea-mention.tsx`, shared by
  `/` skills and `#` collections) never owns the textarea value, only deletes the token and
  hands back an id. Accepting a row falls back to `setRangeText` when native delete isn't
  available, which edits the DOM behind React's back and leaves React's value tracker holding
  the pre-accept string — the next keystroke that recreates that string is silently swallowed
  until a synthetic `input` event resyncs it. Its twin: the dismissal key returns the caret to
  where the token started, so retyping the trigger rebuilds a byte-identical signature and a
  signature-only dismissal check kept the list closed. Both together show as one symptom: add a
  collection, remove the chip, type `#` again, nothing happens.

## Retrieval and direct context

- Knowledge mode is decided twice: metadata at turn time (`fitsDirectContext`) and the rendered
  prompt at dispatch (`prepareKnowledgeContext`), which may downgrade "context" to retrieval but
  never the reverse. Selection authorization failures are sticky terminal errors, even after the
  final provider call, and never become recoverable failed tool results.
- Direct context includes every selected document or none, sits after retained history in
  protected trailing position, and cites through the `knowledge_context` activity. Retrieval
  offers `list_documents`, `search_knowledge`, `read_document` (shared 64 operations, 3 permits,
  24-round ceiling), steered to search first since a search already returns the references a
  read needs. A search hit is a bounded excerpt (`searchExcerptChars`, 800) so a multi-query
  batch keeps all its hits instead of spending the cap on the first few whole chunks.
- Document sources are namespaced by `kind` (`document` vs. `web`) so citation indexes never
  collide and documents grant no web URL authority; both chat and research project results
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
- Owners see one repair, Rebuild index (`rebuildIndex`): re-extract stale documents, then
  re-embed only versions not indexed for the current model, safe to run on any doubt.
  `rebuildContent`/`reindex` stay separate services internally — don't resurface them as
  separate owner-facing actions. Admin Rebuild all queues only stale work, per collection as
  each owner.
- `pipelineFingerprint` (parser + `CHUNKER_REVISION`) is recorded on every published version, so
  a pipeline improvement never rewrites one: `rebuildContent` queues a new version only where
  the current pipeline couldn't have produced it, and keeps the old one readable/citable until
  the new one is ready. Identical replacement saves reuse the latest version.
- Postgres refuses NUL (U+0000) in `text`; pdf.js emits it for private-use glyphs.
  `stripControlCharacters` guards every extraction — without it `completeExtraction` dies and
  the row sits in `extracting` until the lease lapses, so the owner sees a "timeout" that is
  really three failed attempts. A textless PDF page is skipped, not failed (`truncated: true`
  refuses direct context and tells the model coverage is partial); a fully textless PDF still
  fails, with the scanned-PDF hint.
