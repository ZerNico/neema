# CLAUDE.md

Chat app — modular monolith. TanStack Start + Effect 4 (rc) + Drizzle 1 (rc) + Better Auth.
See README.md for architecture; this file records the sharp edges.

## Version pins (all release candidates — pin exactly, don't float to `latest`)

- `effect@4.0.0-rc.x` and every `@effect/*` package must share the SAME rc version
  (`@effect/vitest`, `@effect/sql-pg`, `@effect/ai-openrouter` are on the `rc` dist-tag).
  `latest` on those packages is still Effect 3 — never mix.
- `drizzle-orm` / `drizzle-kit` are on `1.0.0-rc.5-*` builds. rc.4 crashes at import time
  with effect >= 4.0.0-beta.104 (`Schema.TaggedErrorClass` was renamed to `Schema.TaggedError`).
- `vitest` must be v4 (peer of `@effect/vitest` rc) — v5 exists but the peer range is
  `>=4.1.0 <5.0.0`. `katex` stays on 0.16 for the same reason: `@streamdown/math` pins
  `rehype-katex@7`, which pins `katex@^0.16`.
- `@effect/ai-openrouter` is patched (`patches/`) and cannot currently be un-patched. The
  patch adds five behaviours the package does not have: assistant `file` parts sent back as
  `images` (image replay), the `imageReplay` prompt option that bypasses reasoning-detail
  deduplication, `refusal` deltas streamed as answer text, unmodified ordered
  `reasoningDetails` on the finish part, and a normalizer for OpenRouter's documented
  image deltas, which omit the `type: "image_url"` discriminator that
  `Generated.ChatAssistantMessage.images` requires. All five live inside `prepareMessages` /
  `makeStreamResponse` / the SSE decode, none of which a provider wrapper can reach — the
  Hermes-style wrapper only sees prompts in and parts out. On a version bump, diff the new
  `src/` against the old one first: rc.111 → rc.112 was byte-identical, so renaming the patch
  file and its `pnpm-workspace.yaml` key was the whole upgrade. A patch that stops applying
  is caught — 9 tests across `image-replay.test.ts` and `gateway.test.ts` run against the
  real adapter, not a mock, and fail without it.
- `@tanstack/charts` is pre-alpha — pinned exact (no caret); its API may change
  between releases, so re-probe the analytics charts on any bump.
- `rolldown` no longer needs an override. 1.2.2–1.2.5 emitted an undeclared `ssr_exports`
  from Nitro's split SSR bundle ([#10734](https://github.com/rolldown/rolldown/issues/10734));
  the fix ([#10743](https://github.com/rolldown/rolldown/pull/10743)) landed in 1.2.7, and the
  version Vite resolves passes the production module check and the built-server smoke test.
  Re-pin only if that check fails again.

## Effect 4 API notes (differs from most Effect 3 docs online)

- Services: `class X extends Context.Service<X, Shape>()("id")`, layers built explicitly
  with `Layer.effect` — there is no `.Default` or `dependencies` option.
- `Schema.toStandardSchemaV1(schema)` converts to Standard Schema for TanStack
  `.validator()` / Form `validators`.
- `Effect.forkDetach` (was forkDaemon), `Fiber.join`, `PubSub.subscribe` needs a Scope,
  `Stream.fromEffectSchedule`, `Stream.toReadableStreamWith(stream, context)`.
- `Effect.catch` (not `catchAll`); `Effect.timeout` takes a `Duration`, not a string.
- Drizzle Effect client: `makeWithDefaults({ relations })` from `drizzle-orm/effect-postgres`;
  requires `PgClient` provided at the composition root (`src/server/runtime.ts`) so the
  SyncBus LISTEN/NOTIFY shares the same pool.

## Tool calling (`effect/unstable/ai`)

- `LanguageModel.streamText` is ONE model turn. The multi-turn tool loop is ours
  (`src/modules/chat/server/streaming.ts`): re-run while `finish.reason === "tool-calls"`,
  feeding the previous turn back with `Prompt.concat(prompt, Prompt.fromResponseParts(parts))`.
- `OpenRouterLanguageModel` only emits the `finish` part when a chunk carries `usage`.
  A provider (or mock) that omits usage hangs the loop forever — real OpenRouter always
  sends it because the client forces `stream_options: { include_usage: true }`.
- Every model call is a **streaming** chat completion, side generations (titles,
  compaction summaries) included. `@effect/ai-openrouter`'s non-streaming `ChatResult`
  requires `system_fingerprint`; plain OpenAI-compatible servers omit it, so
  `LanguageModel.generateText` fails to decode against providers whose streaming path
  works fine (`ChatStreamChunk` marks the same field optional). `AiGateway.generateText`
  folds the stream instead — usage rides the finish part, and a provider that never
  sends one yields a zeroed `Response.Usage`, which bills nothing rather than failing.
- A handler's second arg is `Toolkit.HandlerContext`: `ctx.preliminary(result)` streams
  progress as `tool-result` parts with `preliminary: true`. Those are UI-only — the
  stream loop must keep them out of the continuation transcript.
- No-argument tools use `Tool.EmptyParams`, not `Schema.Struct({})`: the latter emits
  a root `anyOf` accepting objects or arrays, which is not a portable function-tool schema.
- `capabilities.tools` means **native** tool calling and gates nothing: every chat model
  takes every tool. A model without it is wrapped in `resolveModel` (`gateway.ts`) by the
  Hermes polyfill (`src/modules/providers/server/hermes-tools.ts`), which renders the
  tool signatures as a `<tools>` system block, rewrites assistant tool calls and tool
  messages as `<tool_call>`/`<tool_response>` text so the wire never carries `tools`,
  `tool_calls` or `role: "tool"`, and parses `<tool_call>` blocks out of the stream into
  `tool-call` parts with `finish.reason` rewritten to `"tool-calls"`. It must stay inside
  the provider boundary (adapter → hermes → think extraction) so the toolkit loop never
  learns the difference. The wrapper's hooks must return **encoded** parts: the inner
  service hands out decoded ones (`response-metadata.timestamp` is a `DateTime`), so
  everything except the synthesized tool calls is re-encoded through
  `Response.StreamPart(Toolkit.empty)`. Malformed JSON, an unknown tool name and fenced
  examples of the format are re-emitted as text, never as a call.
- Tool page bodies are never persisted. `message_tool_calls.result` holds the summary
  plus the source list (url/title/status) only.
- Every web tool (web_search, read_url) returns the SAME result shape
  (`WebToolResult`) on purpose: streaming persistence, tool envelopes and the
  citations UI are written once against those fields — a new tool that speaks
  them needs no pipeline changes, only name-aware labels in
  `tool-activity-block.tsx`. `targets` contains search queries or reader URLs.
- `web_search` is snippet-only and accepts several queries in one call. It never
  fetches result pages. `read_url` accepts several URLs, fetches them concurrently,
  and is the only path through `PageExtractor`, whose `url-safety.ts` guard is the
  SSRF boundary: http(s) only, no credentials, private/reserved addresses refused
  for the URL and every redirect hop. The SearXNG base URL is exempt by design.
- `web_search` shares pending queries and caches successful results (including empty
  results) per generation, keyed by query, time range and language. Only the producer
  takes a permit and admits one query immediately before calling the backend. Cached
  and shared hits survive a spent budget; mixed batches keep available results and
  identify refused targets. Failures are evicted. Producers belong to the generation's
  `Effect.scoped`, with waiter counts: cancelling one worker preserves other waiters;
  the last waiter or generation shutdown interrupts abandoned work. Research shares `RESEARCH_LIMITS.externalOps` (3) permits across every
  worker; SearXNG fans each query to every enabled engine at once, so that number
  times the engine count is the burst the upstreams see. `infra/searxng/settings.yml`
  enables only Bing and Yandex for general search on purpose: Bing under bot
  suspicion returns unrelated pages rather than an error, so it must not be the
  only engine, and the others suspend on the first burst.
- Search follows the per-message composer toggle. The reader rides with an armed
  search so the model can open its hits, and is also armed when user-authored text
  or prior persisted sources seed URL authority. Search hits extend that authority
  during the generation; assistant prose never does, so invented URLs are refused.
  `searchEnabled` gates search ONLY, history citation-marker stripping keys off
  whether any tool is armed (`webToolsEnabled`). Retry uses the target's saved search
  setting, capped by current availability, for plain and agent conversations alike;
  prior tool usage never changes that setting. Edits use the submitted search choice.

## Deep research

- Research is a persisted **request mode**, not a conversation setting. Valid structured
  answers inherit it server-side; ordinary text does not. Retry/edit use the target's saved
  mode, and retry installs a fresh `researchRunId` even when the message ID is reused.
- Research writes hold the conversation lock and validate current run/owner/lease. Stop
  carries the expected run ID; local cancellation, SSE events and client hook identity must
  carry it too. Research tails ordered DB chunks every second; ordinary chat keeps its
  existing local live tail. Expired research is terminalized, never automatically resumed.
  Keep the active SSE subscription through `done` even if a sync refresh sees the terminal
  row first; otherwise the sticky overlay can strand undisplayed questions and stale status.
- `conversation-research.ts` owns the main assistant: clarification, a memory-aware
  self-contained brief (the existing `planning` phase), and the sole final synthesis.
  `research/runner.ts` receives only that brief and a separately constructed investigation
  execution object — no raw conversation history, memory snapshot or final-text sink.
  Selecting research forces investigation; briefing prose cannot opt out. If the first
  coordinator returns no assignments (including an immediate `finish_research`), admit
  the brief itself as one task through the normal budget and worker path. Merely calling
  the coordinator does not guarantee investigation — simple questions made it finish
  before any report existed. There is no polished investigator answer followed by a rewrite. `research/execution.ts` keeps one
  budget, lease/fence, deadline and accounting stream through the final assistant answer.
  Task-relevant remembered constraints can enter the brief through model selection; this
  is context isolation, not a guarantee against semantic disclosure by the briefing model.
- Clarification is internal: discard its prose and emit only validated `ask_user` activities.
  Only main-assistant synthesis writes outer research prose; a model ignoring the stage
  policy must not leak an uncited answer before investigation. Context-overflow repair
  may retry synthesis only before any answer text was emitted; after that it ends partial,
  never appends a restarted answer.
- The research row in the transcript is one line: live phase plus the current
  search/read while exploring, then `Researched N sources`. It settles the moment
  synthesis starts, not when the message completes: the answer streams below it
  like any reply, with the ordinary "Thinking…" before the first token, so there
  is no "writing" state for a research turn. It opens the run's activity panel (`research-panel.tsx`:
  searches and reads grouped by task) under its own panel id. The detail panel
  snapshots its body at open; `ResearchPanelOwner` beside ChatView's virtual list
  refreshes body and subtitle in a commit effect from the final persisted/live display.
  Selection is message + run ID, independent of bubble mounts. Identity-checked refresh
  cannot reopen a closed panel or replace Sources; a retry closes the superseded run.
  There is no module-level message cache or render-time publication. The sources list
  stays a separate panel reached from the message menu, and lists sources without
  an extraction badge: whether a page was read or only snippeted is a model-facing
  distinction (`evidenceManifest`), not a reader-facing one. The plan and
  worker reports never render, and a failed read is never a user-facing limitation:
  the worker prompt tells the model to route around it. `progress.limitations` is
  likewise written for synthesis and the run record, never shown verbatim: the panel
  reduces it to one plain coverage sentence (`coverageNote`) and says nothing for the
  routine cases — a provider hiccup on one of thirty calls, a report at its output
  cap, incomplete usage accounting. A task that failed reads "Incomplete", not "Failed". An `awaiting_answer` run
  renders nothing, because its question card follows and the answered run continues
  in the next message.
- Synthesis is told to cite sparingly: one marker at the end of a claim worth
  verifying, the strongest source, at most two per sentence, none on common knowledge
  or summary lines. Without that the answer arrives with a chip on every clause and
  reads as a bibliography; the chips are the same either way, the prompt is the lever.
- Synthesis citations: `validateResearchCitations` accepts plain `[N]` for a
  registered source and normalises it to `[^N]`, because models write both and the
  chip renderer keys off the footnote form. Unregistered footnote handles become
  `[unverified source]`; ordinary bracketed numbers without a registered source stay text.
- SearXNG returns HTTP 200 with `results: []` and `unresponsive_engines` for both
  partial and total failures. The backend requests the enabled general engines from
  `/config` (respecting time-range support) and fails only when every requested engine
  is unresponsive. Missing config or query bang selectors leave participation unknown;
  neither is evidence of a total outage. HTTP/transport failures still fail. The budget
  counts consecutive failed backend queries across all workers (`observeSearch`),
  once per actual backend completion, never per tool batch, waiter, cache hit,
  cancellation or refusal; at
  `searchOutageThreshold` it latches `searchUnavailable`, which ends exploration
  and dispatch, adds one plain limitation, and tells synthesis to say so. One
  failed search is the worker rephrasing; a run of them is the backend down.
- Stage evidence stays assistant-role data, followed by an application-authored user-role
  stage request. Never end coordinator, report or synthesis prompts on the evidence block:
  models that disallow assistant prefill reject it. Include the request in protected trailing
  context so history/active-round compaction and overflow repair cannot drop it.
- Per-call provider timeouts key off stream inactivity (`providerStallMs`), not
  elapsed time: a worker's searches and reads run inside its model stream and
  report progress, so a wall-clock cap fails productive rounds. The run deadline
  still bounds every call. A synthesis that already emitted validated lines ends
  `partial`, never `error` — the reader can see it.
- Every exploring turn ends on a user-role soft budget line (`prompts.budgetNotice`,
  from `budget.remaining()`/`headroom`): workers get their fair share of the shared
  web pool, the coordinator gets run-wide slots and rounds, and the wording tightens
  well before a ceiling refuses anything. It stays last so the prompt prefix keeps
  its cache, and rides the trailing/protected context so compaction budgets it.
- The admin web-search config's optional `researchMaxSearchQueries` caps individual
  queries across all workers (default 80, range 12–120), not tool calls or ordinary chat.
  Resolve it once when research starts; admission and soft-budget headroom use that
  same captured value. Admin edits apply to subsequent runs/retries, never active ones.
  Stage prompts use evidence-based completion criteria and consequential gaps to decide
  when to stop; the budget is a ceiling, not a target or a required source count.
- Per-phase output caps come from the model's configured `contextLength`
  (`researchOutputCaps`), with `RESEARCH_LIMITS.*Output` only as ceilings. The
  resolved `ResearchCallSpec` drives admission, prompt preparation, compaction,
  preflight and the gateway request. Task admission reserves an ordinary worker call,
  all pending reports and synthesis at their own caps, not a shared synthesis reserve.
  Retain full citation-validated task reports within that generation cap; never apply a
  second character cutoff. Later stages fit reports through evidence compaction. A report
  finish reason of `length` signals actual output-limit truncation and adds a limitation
  while preserving the available report, independently of context abridgment.
- Main-assistant history and investigation evidence have separate projections. The main
  history projection retains its start index, injections and checkpoint, including hard
  truncation and overflow repair; later stages never resurrect dropped turns. Investigation
  hands back its current evidence projection, never reconstructs discarded raw reports.
  Coordinator/synthesis evidence is an incremental briefing plus new task reports,
  reduced through accounted compaction. Summarizer input budgets include prior briefings
  and manifests. Failed consolidation falls back to bounded per-task evidence with
  explicit omissions. Worker manifests are task-local; inherited sources remain registered
  but do not become this run's collected evidence merely by being in history.
- `projectResearchProgress` is the explicit durable display boundary for live, terminal
  and branch snapshots. The plan stays run-local and reports stay in task columns, never
  in root tool/SSE progress. Planning text deltas do not publish progress; unchanged
  snapshots are suppressed. Research compaction summary bodies remain server-side for
  checkpoints, never in emitted compaction chunks or public conversation-detail/branch
  events; ordinary chat compaction summaries remain displayable. Tool envelopes require
  their current family discriminator, with no missing-family inference.
- `research/budget.ts` admits actual model calls and batched web targets before execution.
  The first refused web admission latches `webRefused`: further rounds and
  dispatches stop instead of spending model calls on tools that must refuse.
  Reaching a ceiling is the design, not a limitation: it is reported to synthesis
  as an execution bound so the answer discloses it, and stays out of the
  user-facing limitation list, which is for coverage that actually failed.
  All workers share one web semaphore, source indexer and URL authority. Worker prose
  grants no URL authority and never becomes outer assistant text. Child tool/compaction
  activity is nested under the run's root activity, not sorted independently into prose.
- Research calls checkpoint observed usage; finalization appends one idempotent aggregate
  chat ledger row keyed by run ID. Compaction uses its call ID for a separate ledger row;
  it is excluded from the chat aggregate. Missing usage is incomplete/unknown cost, not zero.
  Branch copies terminal display snapshots with fresh IDs, never calls or ledger entries.

## Agents and knowledge

- An agent is a saved chat configuration, never a permission. The first message installs a
  fixed association in `conversation_agents`, not a configuration snapshot. There is no
  swap, reselect or removal in an existing conversation. No association row means plain
  chat; a null agent FK is a deletion tombstone. Deleted or inaccessible agents block new
  attempts with `AgentNotAvailable`, while history stays readable.
- Every new agent attempt (send, retry, edit, validated structured answer and research
  continuation, including in branches) resolves the current revision and dependencies
  through ACL-aware `AgentRepo.get` inside the attempt transaction. Its share lock captures
  coherent instructions/dependencies against edits. Resolve before destructive resets;
  failure must preserve answers, attachments, descendants and research state. An active
  attempt consumes only its captured private execution record, never live settings.
- `message_generation_config` stores private `resolvedAgent` provenance and separate original
  `standaloneCollectionIds`, including overlaps with agent dependencies. Future attempts use
  those inputs, not previous effective dependencies or instructions, and resolve current
  document versions. Plain-chat retry manifests retain their existing semantics. Branches
  copy association/tombstones and historical records, not future configuration defaults.
  Every assistant has a saved config; there is no missing-row inference or snapshot fallback.
  Model/search preferences are selection defaults, never overrides of explicit user choices.
  `configRevision` remains optimistic editor concurrency and execution provenance.
- The composer keeps the fixed agent header (`AgentBar`) but refreshes safe live identity and
  dependencies from conversation detail on resource changes, preserving standalone drafts
  and model/search choices. The editor stays owner-only; recipient projections never expose
  instructions or private execution records. Agent access never grants dependency access.
  Preferred models/search apply once per draft selection, not again on an agent refresh.
- Composer type-ahead is one hook, `useTextareaMentions` (`src/ui/textarea-mention.tsx`),
  driven by a list of `MentionSource`s: `/` offers skills, `#` offers knowledge
  collections. Triggers are distinct characters, so at most one list is open — the
  sources are tried in order and the first whose token matches at the caret wins.
  `matchMentionToken` only fires at the start of a word, so `issue#5` and a URL's
  slashes stay text. The hook never owns the textarea's value: it deletes the token
  and hands back an id, so what a pick _means_ (add a skill, add a collection with
  its additions delta) stays at the call site. A new trigger is a new source, not a
  second copy of the popup.
- Accepting a row deletes the token through `execCommand("delete")` to keep native
  undo, and falls back to `setRangeText` — which edits the DOM behind React's back
  and leaves React's **value tracker** holding the pre-accept string. The next
  keystroke that recreates exactly that string then compares equal and is silently
  swallowed: the character lands in the DOM and `onChange` never fires. The fallback
  therefore dispatches a native `input` event to resync the tracker. Its twin is the
  dismissal key: the caret returns to where the token started, so retyping the
  trigger rebuilds a byte-identical signature, and a dismissal keyed on signature
  alone kept the list closed. Both bugs show up as one symptom — add a collection
  with `#`, remove the chip, type `#` again, nothing happens — so fixing either one
  alone still looks broken.
- The "+" menu's Agent and Knowledge rows open searchable Base UI combobox popups
  (`AgentPicker`, `CollectionPicker`) anchored to the "+" button. The row queues the popup
  until the menu's `onOpenChangeComplete` so closing focus never steals it. Knowledge ticks
  commit only on Add; Escape/outside clicks discard them. The new-chat screen shows the
  selected agent's identity instead of the greeting.
- OpenRouter's default `GET /models` is text-generation only: embedding models are **absent**
  from it and appear only under `?output_modalities=embeddings`, with
  `output_modalities: ["embeddings"]` and no `text`. `fetchCatalog` fetches both views for
  `kind: "openrouter"` and merges by id; `inferType` maps that modality to `"embedding"`. A plain
  OpenAI-compatible endpoint lists everything in one call and would ignore or reject the filter,
  so it gets the single request; when it omits `architecture` the admin sets the type by hand.
  Rerank/speech/video stay out of the registry. No catalog field carries an embedding model's
  vector width (verified against both `/models` and `/models/:id/endpoints`), so the admin form's
  **Detect** button sends one short `POST /embeddings` through `probeEmbeddingDimensions` and
  reads the width back; it is the only honest source. The add-model dialog shows no settings
  until a row is actually picked — half-typed search text is not a model. Verified against the
  live OpenRouter API on 2026-09-07.
- Group sharing permission is per membership: `group_members.can_share` defaults to false.
  Admins manage it on the group's member rows. Regular owners need that exact enabled
  membership to create an agent/collection group grant; the sharing transaction holds a
  membership `FOR SHARE` lock through insertion so disabling/removal serializes with grants.
  Revoking permission leaves existing grants intact and repeated grants idempotent; removal
  and re-addition resets permission. Admin owners may share to any group or publish to the
  instance, but admin status never permits sharing another owner's resource. Resource events
  refresh both sharing targets and admin group-member queries.
- An agent grant never grants its collections or model: those are checked separately, and losing
  any selected collection fails the whole turn (`KnowledgeNotAvailable`), never a partial answer.
  Agent instructions enter the prompt as a user-role block after the application policies.
- Collections are selected **per message**, like attached files: the composer sends the
  current standalone list with every message and clears it on submit, while the associated
  agent (and its own attached collections) stays for the conversation. The server still
  stores what each generation ran with, so retry/edit never depend on composer state. In the
  transcript a collection shows on the **question** that added it, by name only, beside that
  message's file chips — never as an activity row on the answer, and never with document-level
  detail ("included in full"). The `knowledge_context` activity still exists for citations and
  replay; the answer simply does not render it.
- Admin **Documents** page (`knowledge-admin-page.tsx`, `/admin/documents`) owns both halves of
  "how documents become searchable": semantic search (embedding model) and document parsing.
  Neither is a chat tool, so neither lives under Tools. Only enabled, `access: "public"`
  embedding models are offered; enabling or switching confirms that document text goes to that
  provider, and a same-dimension switch asks whether existing vectors stay comparable — "keep"
  is the admin's claim, never inferred from a name or dimension count. Approval never
  bulk-submits corpora; **Rebuild all** does, but queues only stale work (`rebuildAllIndexes`
  runs the owner-scoped `rebuildIndex` per collection as each owner — no cross-user
  transaction).
- Two model pickers, on purpose: `ModelPicker` (chat composer, retry menu, agent editor) is the
  searchable, provider-grouped, capability-annotated combobox for users choosing among many
  models often; `ModelSelect` (`providers/ui/model-select.tsx`: default model order, semantic
  search) is the plain admin dropdown with "Name · Provider" wording and an optional detail
  such as "4096d". New admin model dropdowns use `ModelSelect`. A Base UI `Select` renders the
  chosen label only when given `items`, otherwise the trigger shows the raw value; the shared
  component passes the label both ways.
- Knowledge mode is decided twice: metadata at turn time (`fitsDirectContext`) and the rendered
  prompt at dispatch (`prepareKnowledgeContext`), which may downgrade "context" to retrieval but
  never the reverse. Final toolkit assembly follows that prepared mode, not the saved
  metadata estimate. Selection authorization failures are sticky terminal errors, including
  after the final provider call; they never become recoverable failed tool results in chat
  or research. Already-streamed text can remain visible but cannot complete successfully.
  Direct context includes every selected document or none, sits after retained
  history in protected trailing position, and registers its citations through the
  application-authored `knowledge_context` activity. Retrieval offers `list_documents`,
  `search_knowledge`, `read_document` (shared 64 operations, 3 permits, bounded encoded results,
  exact continuations) with a 24-round ceiling.
  The retrieval prompt and the tool descriptions steer the model to **search first**: a search
  already returns the document/version references a read needs, so `list_documents` is for
  questions about the collection itself, never a reflexive first call. A search hit is a bounded
  excerpt of its chunk (`searchExcerptChars`, 800), so a three-query batch keeps all its hits
  instead of spending the response cap on the first few whole chunks; `read_document` opens the
  exact range. In the transcript, a run of knowledge calls is one collapsed row shaped like the
  web row (`assistant-body.ts` groups them): the header counts excerpts, the disclosure lists
  the queries; the start envelope carries them so the row can say what it is searching while it
  runs. Reads and listings are counted, since their targets are opaque version ids. The source
  viewer speaks plainly — no character offsets — and turns `[page N]` marker lines into page
  dividers, skipping the one that merely repeats the page already named above the excerpt.
- Document sources are `{ kind: "document", collectionId, documentId, versionId, startOffset,
endOffset }` beside explicitly tagged `{ kind: "web", url, ... }` sources; missing kinds
  are invalid. Identities are namespaced so citation indexes never collide, and documents
  grant no web URL authority. Tool result bodies are model-only: chat and research use
  `projectKnowledgeToolResult` to validate and project results before rows and the wire.
- Document range reads walk 4,096-code-point blocks inside PostgreSQL, counting non-BMP
  characters as two UTF-16 units; only intersecting blocks cross the connection. Search
  chunks are not the original body and cannot reconstruct inter-section whitespace.
  The service rejects starts inside surrogate pairs and backs end cuts up to a complete
  character, preserving exact continuation offsets. Document lists and download authorization
  query metadata only; direct-context body reads are batched separately.
- Indexing publishes a content-free `knowledge.index.changed` event, not a policy change.
  The client coalesces these into knowledge-only refreshes, lets an in-flight fetch finish,
  and schedules one follow-up for intervening events. First SSE open reconciles knowledge
  too: completion can happen between the initial fetch and subscription.
- The optional `update_plan` checklist is an agent preference (`planEnabled`), offered only to
  tool-capable models. Each accepted call replaces the whole list; the prompt carries one current
  snapshot in the trailing reminder, never a history of revisions, and retry/edit start clean. A
  completed step is the model's claim about its own work, so neither the prompt nor the UI
  presents it as verified coverage. Deep research keeps its internal plan; the two never mix.
- Physical bytes and rows cannot commit together, so `blob_cleanup_intents` records the risky
  half first: a `candidate` before an upload stores bytes, an `orphan` inside the transaction
  that drops a blob's last reference. A reconciler settles them by asking whether any row owns
  the key — never by trusting the caller's error, since registration may have committed anyway.
  In-flight uploads are protected by a grace period, and a failing store backs off instead of
  spinning. Post-commit deletion is still the fast path; the ledger is what makes it recoverable.
  Due-ness is judged by the database clock (`not_before <= now()` in SQL), never a JS `Date`:
  the two drift by milliseconds, and a reconciler that quietly sees nothing is the exact failure
  the ledger exists to prevent.
- Integration suites must start `POSTGRES_IMAGE` (pinned pgvector), never `postgres:17-alpine`:
  the knowledge migrations create `vector` columns and fail on the stock image with a bare
  "drizzle-kit migrate" error that names no cause.
- Owners see one repair, **Rebuild index** (`rebuildIndex`): re-extract documents whose text
  predates the current parser/chunker, then re-embed only versions not indexed for the current
  model. Healthy documents are never touched, so it is safe to run on any doubt. The two halves
  stay separate services (`rebuildContent`, `reindex`) for admin flows and tests; do not surface
  them to owners as separate actions again.
- Conversation starters render on the new-chat screen for the selected agent and only seed the
  draft; they never send on their own.
- **Vector width vs. pgvector.** The embedding column is bare `vector` (no fixed width) and
  search is an exact cosine scan filtered to one space; there is deliberately no HNSW/IVFFlat
  index. That is what lets a 3,072- or 4,096-dimension model work: pgvector stores up to 16,000
  dims but indexes only up to 2,000. The app caps at 8,192 (gateway, admin schema, probe). Exact
  scan is fine for the bounded corpora here (500 docs/collection, five selected collections).
  If ANN ever becomes necessary, the options are `halfvec` (indexable to 4,000, any model) or
  Matryoshka truncation via the `dimensions` request parameter — **only** for models trained for
  it (OpenAI 3-series, Voyage; not Qwen3-Embedding). A per-space decision at approval time, not a
  global index. `knowledge.test.ts` pins a 4,096-wide space.
- The approved width (`expectedDimensions`) **verifies** embedding responses; it is never sent as
  a `dimensions` request parameter. Sending it asks the provider to truncate, which non-Matryoshka
  models may reject and OpenRouter's reference leaves unspecified. Every model's native width is
  what Detect recorded, so the response check is the whole contract. `gateway.test.ts` pins the
  request body.
- `pipelineFingerprint` (parser + `CHUNKER_REVISION`) is recorded on every published version.
  Content is immutable, so improving the pipeline never rewrites a version: `rebuildContent`
  queues a _new_ version from the retained source for documents the current pipeline could not
  have produced, keeps the old one readable and citable until it is ready, and skips documents
  whose replacement is already pending. Notes and text files have their own identities, so a
  PDF-parser change does not invalidate them.
- Identical replacement saves reuse the latest version (pending or failed included); explicit
  retry is separate. Research workers share the knowledge tools, budget and indexer.
- Postgres refuses NUL (U+0000) in `text`; pdf.js emits it for private-use glyphs (emoji,
  ticket QR fonts). `stripControlCharacters` runs on every extraction, decoded text file and
  saved note. Without it `completeExtraction` dies (`orDie`), the worker logs, and the row
  sits in `extracting` until the lease lapses, so the owner sees a "timeout" that is really
  three failed attempts.
- A textless PDF page is skipped, not a failure: the parser keeps its `[page N]` marker so
  later page numbers stay aligned, and the version publishes with `truncated.reason` naming
  the pages. The owner sees a plain ready document (no badge, no reason line, by request);
  the manifest keeps `truncated: true` so direct context is refused and the model is told
  coverage is partial.
  A PDF with no extractable text at all still fails with the scanned-PDF hint.

## Portable skills

- A skill is a SKILL.md package (`src/modules/skills`), not a permission and not a tool. The raw
  document is the ONLY metadata source: name/description are parsed from its frontmatter, so there
  is no competing metadata form state. Nothing in a package ever executes: unsupported directives
  (hooks, `context: fork`, shell substitutions) are flagged once on SKILL.md, and script files are
  kept as ordinary text without a warning per file — the editor says scripts are never run.
- Revisions are immutable; files live in the existing BlobStore/`attachment_blobs` registry with
  candidate/orphan cleanup intents, deduplicated per user by SHA. `collectUnused` runs two passes
  (superseded local revisions, then their newly unreferenced baselines) and retains anything a
  `message_skills` row or another revision's baseline pointer references. Soft deletion blocks new
  attempts while history stays readable and its blobs stay put. Reclamation is currently triggered
  by a skill save or removal, not by history deletion.
- An imported upstream baseline is stored as a **negative** `skill_revisions.revision` ordinal on the
  same skill: same immutable file lifecycle, never exposed through any public API. An update applies
  the fetched upstream as the new baseline even when the owner keeps local choices, so the next
  three-way comparison (`update.ts`, whole-file only, no text merge) stays honest.
- `SkillReader` is a private execution-only service; owner detail/export/baseline reads live in
  `SkillService`. Recipients get safe metadata plus invocation, never bodies or the editor API.
  Instructions can't be kept secret from someone who can use the skill — the editor says so.
- Every new attempt (send, retry, edit, structured answer, research continuation, branch) resolves
  current revisions and ACLs inside the attempt transaction, before any destructive reset. Original
  standalone IDs stay separate from agent dependencies, including overlaps, so removing a skill from
  an agent leaves an explicit selection intact. Active attempts pin content but recheck access:
  losing it is sticky and terminal, never a recoverable failed tool result.
- Skills the reader can access are offered automatically: `SkillRepo.catalogue` adds every readable,
  non-manual-only skill as an `ambient` manifest entry at dispatch (chat and research alike), on top
  of the attempt's pinned selections. Ambient entries are metadata-only offers — they are NOT
  authorized as attempt dependencies, so losing access to one never fails a turn, while `readPinned`
  still checks access per read. Unavailable ambient root/file reads return bounded tool errors;
  only explicit/agent dependency failures latch terminal authorization loss. Missing files and
  defects remain distinct from permission failures. The prompt says the descriptions are all the model has and to call
  `load_skill` when one matches; without that instruction a listed skill simply never gets used.
- An agent's own skills sit between the two tiers: offered on demand like an ambient entry,
  authorized like a pinned one, and marked `forThisAgent` in the catalogue with a prompt line
  telling the model to prefer them. Without that marking the catalogue is flat and an agent's
  skills are indistinguishable from everything else the reader happens to own — which made
  attaching one a near no-op that only converted "silently not offered" into a hard turn failure.
  Attaching is a preference, never a pin: agent skills are offered, not preloaded.
- Manual-only means "never offered on its own", not "unusable". The ambient query excludes those
  at the source, so a deliberate selection or an agent attachment is the only way to reach one —
  filtering the catalogue on `explicit` alone left an agent's manual-only skill authorized, able to
  fail the turn, and silently absent from the list. The catalogue filter keys off `ambient`.
- `load_skill`/`read_skill_file` are bounded (20 catalogue entries, 5 loaded, 32 shared operations,
  2 concurrent reads, exact UTF-16 continuations). Roots enter protected context once and are never
  duplicated into tool output; required instructions that don't fit are refused, never truncated.
  Research workers share one session, budget and semaphore.
- `projectSkillToolResult` is the only path to durable rows and SSE, and every displayed field is
  length-bounded (`SKILL_ACTIVITY_LIMITS`): an activity row is a label, never a transport for
  package text. Envelopes require `family: "skill"`; there is no missing-family inference.
- Remote import is fixed-host (skills.sh, api.github.com, raw.githubusercontent.com) on top of the
  existing `url-safety.ts` guard, with per-request and whole-review deadlines, manual redirects,
  `credentials: "omit"` and streamed byte caps. `parseSkillUrl` rejects dot segments and encoded
  separators BEFORE `new URL` normalizes them away, and a slash-bearing branch is resolved through
  `matching-refs` (longest actual ref wins) rather than guessing where the branch name ends. All
  files are read at one resolved commit SHA, and a known package path reads only that subtree
  (`{commit}:{path}`) — a whole-repository tree is megabytes for collections like anthropics/skills.
  Import and update hold NO server state: the client names the reviewed repository, commit, path and
  locally computed content hash, and the server re-reads that immutable commit and refuses anything
  whose hash differs. Server memory does not reliably survive between requests, so a token store
  made every import fail with "review expired"; the hash is the guarantee, not the token.
- Discovery uses the undocumented public `skills.sh/api/search`, which ignores `offset`/`page`, so
  "show more" is a larger `limit` (20 → 100). Ids are one path segment and carry real punctuation
  (`react:components`, `pdf-merge-&-split`): validate addressability, not an alphabet, and skip a row
  that fails rather than failing the page. The response count decides whether more exist — not how
  many rows survived filtering. Link and file imports must keep working when this endpoint does not.
- ZIP reading validates central AND local headers, rejects encryption/links/overlaps, and verifies
  the actual CRC of decompressed bytes against the central directory. Binary/undecodable files are
  reported together, never silently dropped, and nothing is extracted to disk.
- The package review preview drops the mermaid plugin: a diagram can pull external references that
  the Markdown `img` override does not cover, so review keeps those fences as source.

## Memory

- In ordinary chat, `save_memory` availability follows the admin/user auto-save settings,
  independent of attachments, knowledge, skills or web activity. There is no per-save
  confirmation. The handler permits one attempt per generation, and subsequent model turns
  omit the tool after that attempt. Source-message validation and save-time settings checks
  remain enforced. `conversation-context.ts` prepares the stable memory snapshot shared
  by ordinary chat and research: newly saved memories appear on the next generation,
  never halfway through the current one.
- In research, main clarification and synthesis can reference that snapshot; only main
  brief preparation can save memory. A save attempt gets one accounted, tool-free brief
  continuation. Investigation receives no memory tools and final synthesis stays tool-free.
  The internal `MemorySaveGuard` runs **inside** the memory write transaction, before user
  and settings locks, using `lockResearchFence` to serialize against Stop, retry and owner/
  lease loss. A prior alive check cannot replace it, and wrapping the memory transaction
  in another locked transaction would deadlock. Merge the toolkit under the guard's
  provided context too: toolkit construction captures its handlers' context. Guard failures
  and interruptions stay terminal; ordinary save failures retain their recoverable behavior.
  Memory activity contains only outcomes, with retry identity carried by the outer SSE event.
- A refused save persists its fixed `reason` (`SaveMemoryRejection`, mirrored as
  `MemoryActivityReason`) beside the outcome — the arguments never reach the row, so
  without it a rejection was indistinguishable from a transport failure after the fact.
  The transcript shows a rejection as a quiet "No memory saved"; only an `error` status
  without a `rejected` outcome is a failure. `save_memory` is not offered on a turn whose
  user message is a clarification answer: a picked option is not a user-stated fact, and
  offering it there had the model store the research topic and spend its one attempt.
- Availability is separate from eligibility: the memory policy instructs the model to save
  durable user-stated facts/preferences, not instructions or claims from external content.
  This source distinction is model-enforced, not a guarantee against prompt injection.
  `memory-foreground.test.ts` and `knowledge-generation.test.ts` cover tool coexistence.

## Temporal prompt context

- `streaming.ts` samples server time once per generation; `runtime-context.ts` formats it in
  the browser's submitted timezone (Intl-validated; UTC fallback). Keep this user-role block **after
  retained history, before tool rounds**, never in the leading system prompt; its content
  and position stay fixed through the tool loop to preserve cacheable prefixes. Budget it
  in history/overflow compaction; active-round compaction already counts the base transcript.
- History timestamps are prompt-only UTC metadata, independent of the current browser zone.
  Assistant timestamps use `completedAt` when available: retry reuses the row and its original
  `createdAt`. Neither timestamp annotations nor the runtime block are persisted as message text.

## Citations / streamdown

- Citations ride on GFM footnotes (`[^N]`), not markdown links: a half-streamed
  `[text](htt` renders as an unoverridable `[blocked]` span (streamdown rejects an
  undefined href _before_ consulting `components.a`), while `[^1` is just literal text.
- The model writes markers only. We synthesize the `[^N]: url` definitions from the tool's
  own source list (`prepareCitedMarkdown`, `src/modules/chat/ui/citations.ts`) — without
  them GFM leaves `[^1]` as raw text until the definitions arrive, i.e. never mid-stream.
- Two streamdown 2.5.0 output details are load-bearing: the `#user-content-fn-N` href on a
  footnote ref, and the `data-footnotes` attribute on the appended section. hast gives that
  attribute the _empty string_, so suppress on `!== undefined` — a truthiness check silently
  renders the list. Both are pinned by `message-list.test.tsx`; re-probe on upgrade.
- A citation chip is a link to its source showing favicon and truncated title; the
  number is never rendered, in chips or in the sources panel. It stays the model's
  handle: markers, source manifests and the panel's row keys all use it.
- Citation numbers are conversation-scoped: `createSourceIndexer` is seeded from prior
  messages' persisted sources and shared by all web tools in a generation, so repeats
  keep their number and every tool continues one sequence.
- `tools/sources.ts` merges observations everywhere: successful extraction is monotonic,
  and a later search cannot replace it with snippet-only evidence. The Sources panel/counts
  select own cited or extracted sources plus cited inherited sources, never all search hits.
  `citedSourceIndexes` uses the renderer's GFM-footnote parser packages, excluding code
  examples and definition bodies. `read` means page extraction, not reading a page in full.

## Markdown plugins (`src/ui/markdown-plugins.ts`)

- Streamdown 2.x ships highlighting, math, mermaid and CJK handling as opt-in plugins.
  Without them a fence renders as unstyled plain text (every token at `--sdm-c: inherit`),
  `$$…$$` stays literal, and a CJK autolink swallows the punctuation after it — all
  silently, with no error. One shared config feeds all three `<Streamdown>` call sites.
- `katex` is a direct dependency only for its stylesheet: streamdown never calls the math
  plugin's `getStyles()`, so `app.css` imports it. Keep it on the same major as the
  renderer — `rehype-katex@7` pins `katex@^0.16`, so a float to 0.17+ styles markup that
  0.16 produced.
- The math plugin overrides remark-math's default to `singleDollarTextMath: false`; leave
  it there. Enabled, "It costs $5 and $10" renders as the expression "5and".
- mermaid is ~950 KB gzipped and `@streamdown/mermaid` imports it at module scope, so it is
  wrapped in a lazy stand-in — streamdown only needs `getMermaid()` synchronously and
  awaits `render()`, which is where the dynamic import happens. Re-exporting the upstream
  plugin directly would put all of mermaid in the eager chat chunk.
- Diagrams render behind an `IntersectionObserver` + `requestIdleCallback` gate, so they
  stay blank in a browser-automation tab that never paints; the fullscreen button takes the
  `immediate` path and renders regardless.

## Invariants

- One live `ManagedRuntime` per process (`src/server/runtime.ts`). Server functions/routes
  run effects with `runtime.runPromise`. Dev HMR re-runs the module on any layer-graph
  change; each evaluation disposes the previous runtime (globalThis stash) and takes over —
  repo/service edits apply without restarting `pnpm dev`. Vite never calls
  `import.meta.hot.dispose` for server modules, which is why the module does it itself.
- `message_chunks.seq` starts at 1 and is contiguous per message; resume protocol relies
  on it (`?after=<seq>` replays from Postgres, then live tail dedupes by seq).
- Better Auth owns its tables' columns — `src/db/schema/auth.ts` must mirror what
  the installed better-auth version expects, and it moves in patch releases: 1.7.1 added
  `account.issuer` with a unique `(issuer, account_id)` index and 1.7.3 removed both, so
  the column was dropped again here. The schema tracks the installed version only — there
  is no compatibility window for the one before it. After a better-auth upgrade, diff
  `@better-auth/core`'s `dist/db/get-tables.mjs` between the two versions and verify
  against a fresh signup before shipping.
- Provider API keys are AES-256-GCM encrypted at rest (`PROVIDER_KEY_SECRET`, base64
  32 bytes); ciphertext never leaves the server (`toPublic` strips it).
- First registered user becomes admin via the `user.create.before` database hook — do not
  bypass Better Auth for user creation.
- `IdentityBoundary` (`src/modules/auth/identity-boundary.tsx`) pins one identity per
  authenticated tree and replaces the document on any change; it never patches. A `401`
  from any query or mutation ends the session on the spot — `requireSession` writes the
  fixed body `UNAUTHENTICATED_BODY` because the Start client keeps only a failed
  response's text, and `isUnauthenticatedError` matches on it; the two are one contract.
  The focus/visibility revalidation exists for the case a `401` cannot catch: another tab
  switched account or impersonation, so requests *succeed* as the wrong user. It runs
  silently. Hiding the app while it is pending blanked every tab return, and doing it via
  `<Activity hidden>` detached host refs, which Motion treats as a remount — every entrance
  animation on screen replayed. Only the BFCache `pagehide` snapshot hides synchronously.
- `usage_events` is an append-only ledger: one row per generation attempt (chat or
  title), written at finalize time. Retry appends, branching copies nothing, deleting a
  conversation leaves it intact. Analytics reads only the ledger — never
  `messages.usage`, which retries reset and branches clone.
- Nitro's Vite **dev** middleware guesses static assets from `sec-fetch-dest`: anything
  that is neither `empty` nor a document dest never reaches the app, so
  `<img src="/api/files/:id">` 404s while `fetch()` on the same URL works. `vite.config.ts`
  strips that header for `/api/*` (dev only — the built server routes them directly).

## Workflow

- Schema change → `pnpm db:generate` → commit the `drizzle/` folder → `pnpm db:migrate`.
- pnpm settings live in `pnpm-workspace.yaml`, **not** the `pnpm` field in `package.json`
  and not `.npmrc` — pnpm 11 moved them and pnpm 12 stopped reading the old homes. A
  `patchedDependencies` block left in `package.json` is reported once as an ignored key
  and the patch simply does not apply; the build still succeeds, so verify a patched
  dependency by grepping `node_modules`, not by a green install. `allowBuilds` (only
  `esbuild` is true) is a hard error when a package wants a script and is unlisted.
  `minimumReleaseAge` keeps pnpm's 24h cooldown; `minimumReleaseAgeExclude` lists the pins
  this project deliberately tracks same-day (drizzle rc builds, rolldown, `@tanstack/charts`)
  — extend it when a new exact pin hits the gate, rather than lowering the cooldown.
- `pnpm typecheck && pnpm lint && pnpm test` before considering work done.
  Integration tests need Docker (Testcontainers). jsdom applies no stylesheet, and since
  jsdom 27 `getComputedStyle` returns a real `display: inline` for unstyled spans instead of
  `""`, so accessible names no longer get the word space a browser derives from blockifying
  a flex/grid item or an `sr-only` absolute — match those names with `\s?` rather than
  writing the browser-wrong spelling. jsdom 29+ also drops any `linear-gradient` carrying a
  `calc()` stop from the CSSOM (plain `calc()` on a normal property is fine), so a
  gradient mask cannot be asserted from the DOM at all.
  `VirtualMessageList` explicitly opts out of
  React Compiler memoization because `useVirtualizer` exposes a mutable imperative instance;
  keep the targeted lint suppression beside that call until @tanstack/react-virtual is compatible.
- UI primitives in `src/ui/primitives` are shadcn-generated (Base UI, style
  `base-luma`) — regenerate via `pnpm dlx shadcn@latest add <component>`, don't hand-roll.
  The CLI asks to overwrite `button.tsx` on every add (registry dependency); answer no.
  It also adds `next-themes` whenever a component's upstream reads the theme
  (`sonner`) — remove it and wire `~/ui/theme.tsx` instead, as `sonner.tsx` does.

## shadcn / UI conventions

- Deep research is a checkbox item in the Add menu, below files and context. The control
  row shows a pressed Deep research pill only while it is on, and pressing that pill turns
  it off.
  Mode changes only `researchEnabled`; normal chat's independent web-search preference
  stays intact while its toggle is hidden in research. Opening a conversation or the
  new-chat screen focuses the composer, except on a phone (`useIsMobile`), where it would
  raise the keyboard over what the user came to read. Model pickers keep compact rows without a details toggle;
  native tool metadata stays admin-only, never a user suitability distinction.
- Upload-queued composer sends dispatch the current draft and selections together. `Composer`
  keeps one effect-updated request ref, including `onSend`, so an upload cannot pair fresh
  text with stale skills or a stale parent callback. Research mode stays locked while queued;
  failed uploads/sends preserve the draft and selections.
- Agent creation leads with name, instructions and Knowledge, then shows every remaining
  setting on the same page — no More settings disclosure. Invalid fields receive focus on
  submit. Collections are attached through a searchable picker with removable rows, not a
  switch per collection, so the control does not grow with the account.
- Resource owners manage **Access** through `sharing/ui/access-dialog.tsx`, not link copying.
  One panel: a searchable picker (groups first, then a directory of accounts fetched on
  open and on each debounced query — never preloaded), the list of who can use it, then
  General access. `SharingService.recipients` is a deliberate account directory readable by
  any signed-in user, which the exact-email design originally refused; it fits a
  single-tenant self-hosted deployment and nothing else about an account is exposed.
  Picking a person still grants through the existing email path, so authorization is
  unchanged. Every grant is the same permission, so rows carry a plain “Can use”
  label — never a role picker the backend cannot honour. Audience is additive: direct
  grants, groups and everyone signed in can overlap, so removing one grant never implies
  other access ended and the note saying so appears only when a group or broad audience
  actually applies. Broadening to everyone signed in confirms first; narrowing does not,
  because it takes nothing away that was granted directly. Agent access grants no
  dependency access. A `role="combobox"` trigger takes its name from `aria-label`, not
  from its own text.
- Documents say Preparing / Preparing search / Basic search, or Updating / Update failed
  for replacements. The current version remains available during replacement. Initial and
  replacement failures expose Try again; Rebuild index remains the only collection-wide
  repair action. Healthy documents and partial-PDF coverage stay visually quiet.

- `src/styles/app.css` must keep `@import "tw-animate-css"` and
  `@import "shadcn/tailwind.css"` right after `@import "tailwindcss"`. Every
  `data-open:animate-in` / `fade-in-0` / `zoom-in-95` class in the overlay primitives
  comes from `tw-animate-css`; without it overlays pop with no transition and nothing
  errors. `shadcn/tailwind.css` supplies the `data-open`/`data-closed`/... variants.
  The `button { cursor: pointer }` base rule is shadcn's `init --pointer` snippet —
  Tailwind v4 dropped it.
- `cn` is the `cn` package (shadcn's `twMerge(clsx())` replacement); `src/ui/utils.ts`
  only re-exports it. Primitives import from `"cn"` directly (what the CLI emits).
- Pending buttons keep their label: a spinner slides in ahead of the text, never
  replacing it (`"Saving…"` reflows the button). There are exactly two ways to write
  one — `PendingButton` (`src/ui/pending-button.tsx`) for a plain mutation, and
  `form.SubmitButton` for a TanStack form, which renders through `PendingButton` so
  the two cannot drift. Do not hand-roll the spinner/`disabled`/`aria-busy` triple
  again. `aria-busy` is always `x || undefined`: the attribute is absent when idle,
  never `aria-busy="false"`.
- A run of activity in a dropdown item is the exception: a menu item closes on
  activation, so it cannot carry a spinner and `disabled` is the pending signal —
  unless the item sets `closeOnClick={false}` to stay open (account menu), where the
  spinner takes the icon's place.
- `Spinner` is `role="status"` on its own; pass `aria-hidden` inside any control that
  already has a label or `aria-busy`, or assistive tech announces "Loading" twice.
- Loading a page's data is the **route loader's** job (`ensureQueryData`, or
  `prefetchQuery` + `retry: false` when the page renders its own error state), so a
  page body is written against data that is already there. For the windows a loader
  cannot cover, `ListSkeleton` in `page-shell.tsx` is the one pending shape — never a
  bare `null`, a `"Loading…"` paragraph, or a hand-rolled `animate-pulse` div. The
  skills module shipped without loaders and grew all three; that is what the shared
  one replaced.
- Inline errors are `FieldError` (already `role="alert"` + destructive text, and null
  when empty); a size override like `className="text-xs"` is fine, re-deriving the
  colour and role on a `<p>` is not. Non-inline mutation failures stay `toast.error`,
  worded "Could not <verb> the <thing>."
- List filters use `SearchInput` (`src/ui/search-input.tsx`), an `InputGroup` with the
  magnifier as an addon. It is `type="search"`, so tests query `role="searchbox"`.
- Every `HugeiconsIcon` carries `strokeWidth={2}`; the package default is 1.5, and the
  same icon at both weights on one screen is what this rule exists to prevent. Inside a
  `Button`, `DropdownMenuItem` or `Badge` the variant already sizes the svg
  (`[&_svg:not([class*='size-'])]`), so do **not** add `className="size-4"` there — it
  also defeats the `xs`/`icon-xs` sizes. Icons in a plain tile or span still need it.
- "New X" is the control that opens a creation surface; "Create X" is the commit inside
  it. In a confirm title a resource's own name is wrapped in curly quotes
  (`Delete “${name}”?`) because it is user-authored; a person's name is not
  (`Ban ${name}?`). User-facing copy uses curly apostrophes (`isn’t`, `Couldn’t`) —
  a straight one next to a curly one in the same transcript is the bug this prevents.
  Model-facing prompt strings on the server are exempt.
- `activityRowClassName` (`src/modules/chat/ui/activity-row.ts`) is the one-line
  transcript summary row, sitting beside `disclosureTriggerClassName` — a message
  stacks both, so they live together.
- A section has exactly two places for buttons, and which one is decided by what
  the button does, never by which module it is in. `Section`'s `actions` slot
  (top-right, beside the heading) is for "add one of these" — New collection, Add
  member, Add model. `FormActions` (`page-shell.tsx`) is the left-aligned row
  _under_ the fields, for Save/Apply/Reset and for a control paired with the button
  that consumes it; a Save button above the field it saves reads backwards. Use
  `FormActions` rather than a bare `<div>`: a submit button that is a direct child
  of a `flex-col` form stretches to full width, which is how the agent editor ended
  up with a full-bleed Save while every other form had an auto-width one.
- Icons inside a labelled `Button`/`Badge` carry `data-icon="inline-start|inline-end"`;
  the size variants key their optical padding off it. Never `<Button render={<Link/>}
nativeButton={false}>` for navigation — Base UI forces `role="button"`; use
  `<Link className={buttonVariants({...})}>`.
- List rows across admin, agents and knowledge share one anatomy: a `size-9` rounded-2xl
  muted icon tile, a two-line label (name + muted detail), badges beside the name, and a
  trailing chevron for links. The whole row is the `Link` (`className="block"` around
  `ListRow interactive`). Grouped lists use `Section` for their headings, never a hand-rolled
  `<h2>`. Composer context (agent/collections) and included documents on an answer use the
  attachment chip's shell so context and files read as one row.
- Page chrome lives in `src/ui/page-shell.tsx` (`SectionShell`, `Page`, `Section`,
  `ListCard`/`ListRow`, `EmptyState`, `ErrorState`); admin, settings, tools, agents,
  knowledge and the chats index all use it. **`Page` is the scroll container.** The app
  layout's `<main>` is a fixed-height flex child that never scrolls, because the chat
  view pins its composer and virtual list to that height; every other route therefore
  needs its own scroller, and `Page` owns it so a route built from `Page` scrolls by
  construction. Do not wrap `Page` in another `overflow-y-auto` (nested scrollers trap
  wheel events), and do not build a non-chat route without it. `page-shell.test.tsx`
  pins this.
- `DropdownMenuLabel` is a Base UI `GroupLabel` and throws outside a `Group`/`RadioGroup`.
  For a plain hint line inside a menu, render a static `<p>`, not the label primitive. Confirmations go through `useConfirm()` (AlertDialog);
  non-inline mutation failures go through `toast` from `sonner` (Toaster mounted in
  `__root.tsx`).
- In-page cards import from `~/ui/card.tsx`, not the generated primitive. Its
  `cardSurfaceClassName` also styles `ListCard`: flat outlined `rounded-3xl`, with
  background/foreground tokens and no shadow or ring in either theme. Keep layout
  local; lists retain their unpadded divided rows. Floating overlays (dialogs,
  popovers, menus, sheets) retain their generated elevation.
- Chat disclosures use `~/ui/disclosure.tsx` for measured-height/opacity animation,
  reduced-motion and hidden-until-found handling, plus shared trigger/chevron/rail
  recipes. Keep each consumer's open state, timers and scroll behavior local.
- Radius scale is 2xl/3xl/4xl for app-authored chrome (rows/cards/buttons), not a
  mandate to change generated primitive density or tiny chart/favicon geometry.
  Semantic colour tokens only — `success` and `warning` exist alongside
  `destructive`; `text-2xs` is the one size below `text-xs`.
