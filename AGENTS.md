# AGENTS.md

A self-hosted chat app for talking to LLMs: conversations, resumable streaming, web
search, deep research, knowledge collections, saved agents, skills and memory. Single
tenant, one Node process, Postgres. Stack: TanStack Start, React 19, Effect 4 (rc),
Drizzle 1 (rc), Better Auth, Base UI/shadcn, Vitest. `CONTRIBUTING.md` has the layout and
the commands; this file has what you need before you touch anything.

The web package is `apps/web/`, the desktop shell is `apps/desktop/`, and shared
packages live in `packages/`. In this file, paths beginning `src/`, `tests/`, or
`drizzle/`, and `vite.config.ts`, are relative to `apps/web/`. Root scripts and
`docs/` paths are repository-relative.

## Glossary

Several ordinary words mean something specific here. Get these wrong and you will
edit the wrong thing.

- **agent**: a saved chat configuration (instructions, model, collections, skills) a
  user picks for a conversation. Never a permission, never the coding agent editing
  this repo. Installed once per conversation in `conversation_agents`; no swap.
- **message / attempt / generation**: one assistant message row can be generated
  more than once (retry, edit). Each attempt has its own `generationId`. Client
  stream identity is message + generation, so a stale attempt's chunks are
  dropped, not merged.
- **turn**: one user message plus the assistant message answering it, created
  together (`createTurn`).
- **run**: one deep-research execution: a `research_runs` row with one budget,
  lease and deadline. It is a unit of work owned by the `deep_research` call that
  started it and fenced by that call's generation — never a kind of message, and
  one turn may start several. Ending one must not touch anything else on the
  message.
- **schedule / scheduled run**: a `schedules` row firing one prompt on a cron
  cadence into a chat: a new one each fire, or one chat it keeps using
  (`chatMode`). Run chats are ordinary sidebar chats; each fire is recorded as
  a `schedule_runs` row. Prose says "scheduled run" — bare "run" still means
  a research run. Catch-up-once: downtime collapses to a single fire, never a
  replayed backlog.
- **task / worker / coordinator**: inside a run, the coordinator dispatches tasks;
  each task is investigated by a worker with web tools. Neither sees the
  conversation or memory; they get a brief.
- **fence**: the tuple that proves a writer still owns a message (`GenerationFence`,
  `ResearchFence`). Every durable write checks it; Stop, retry and lease expiry
  invalidate it. `ResearchFence` is the ordinary generation fence plus the run's
  lease and owner.
- **source / citation**: a source is a numbered web page or document excerpt
  registered during a generation; a citation is a `[^N]` marker in model text that
  resolves to one. Numbers are conversation-scoped and never shown to the reader.
- **collection / knowledge document / version**: knowledge is collections of documents;
  each document has immutable versions; search runs over the current version's chunks.
- **document** (conversation or project document): editable Markdown owned by one chat or
  one project, edited live by people and the model as a ProseMirror tree the server orders,
  stored beside its Markdown. Never knowledge versions or transcript content.
- **project**: instructions, documents, files and memory shared by members (owner,
  editor, viewer) for continuing work. Chats in it stay their owner's alone; each attempt
  re-resolves the project like an agent. Project memory holds facts about the work,
  never about a person.
- **project file / file version**: a binary working file (a deck, a spreadsheet, a Word file) kept in
  a project. Every save is a new immutable version; history is pruned, never the current
  one. Not a document and not a chat attachment, though its bytes share their blobs.
- **custom tool**: an admin-authored TypeScript module containing one or more
  model-callable functions named `custom_<module>__<function>`. Offered in every
  chat the sender may use it in; an agent narrows the offer to what it attached.
  Exact npm dependencies are bundled into the module's one stored row; a save
  replaces it and an attempt resolves modules as they are at turn time, so a
  tool-call row carries the display name it needs. A function may take files through
  `fileInput` and return files; returned ones become attachments of the answer. Workers contain hangs, not authority: code is
  trusted and has the server’s filesystem, environment, network and process access.
- **integration / type / connection / source**: a type is a service the code ships an
  adapter for (Outline, Outlook, Jira); an integration is an admin-configured instance of a
  type, with its own id and name, so there may be two of one type. Stored `integrationId`s
  name the integration, never the type. A connection is one person's
  credentials for it, never shared; chats, agents and schedules use the sender's own. A
  knowledge source mirrors part of an integration into a collection as the collection owner.
  An allowance is a manifest-declared way calls reach people (sending mail, inviting); a
  schedule grants it for exact addresses only, capped per run.
- **skill**: a `SKILL.md` package the model can load on demand. Not a tool, not a
  permission. `ambient` skills are offered automatically; explicit ones are pinned.
- **memory**: a saved user fact the model may reference or write. One save attempt
  per generation.
- **structured answer**: a user message that answers an `ask_user` clarification.
  It is its own submission and inherits no composer toggle.
- **branch**: a copy of a conversation prefix into a new conversation. Copies
  messages, tool rows and display snapshots with fresh ids; never copies chunks,
  calls or ledger rows.
- **temporary chat**: a conversation flagged `temporary` at creation. It is left out of
  lists and search, neither reads nor saves memory, and is swept a day after its last
  activity. Keep clears the flag; nothing sets it later.
- **ui block**: a ` ```ui ` fence in an answer, drawn as interactive UI. Its logic runs
  in QuickJS and only JSON reaches the page. Identity is the fence's ordinal in the raw
  message text. State the reader sets is saved per block, and images are found by query
  when the fence closes. Not an attachment, not a tool. See
  [generative UI](docs/internals/generative-ui.md).
- **queue entry / steer**: a message held behind the live generation, with its
  own claimed files; it becomes a user message when promoted. A steer hands one
  to the running generation at its next safe boundary instead, and from then on
  belongs to that attempt like its tool rows. A queue entry is never a
  transcript row, and never copied by a branch.

## The ways to hurt yourself

1. **Direct package database commands need an explicit URL.** Never use them for
   testing migrations or destructive SQL against a real database. Root dev and
   database commands use checkout-isolated state on a dedicated Postgres at
   `127.0.0.1:5433`, provisioned by `pnpm dev:setup`; they do not read `.env`.
   See [development isolation](docs/internals/development.md).
   Integration tests get a throwaway Postgres from Testcontainers.
2. **Integration tests need the pinned image and share one server.**
   `tests/integration/postgres-image.ts` pins a pgvector image;
   `postgres:17-alpine` fails migrations with a bare "drizzle-kit migrate" error
   that names no cause. Docker must be running. `global-setup.ts` starts one
   server per run and migrates a template once; each file calls
   `createTestDatabase()` for its own clone. Server-wide views such as
   `pg_stat_activity` must filter `datname = current_database()`, or a test
   sees, and may terminate, another file's sessions.
3. **Vitest projects are by extension.** `--project unit` is `src/**/*.test.ts`,
   `--project ui` is `src/**/*.test.tsx`, `--project integration` is
   `tests/integration/**`. Running a `.test.tsx` under `unit` prints "No test
   files found" and exits green. That is not a pass. A package under `packages/`
   runs its own `vitest.config.ts` (`pnpm --filter @chat/sheet test`), not `--project`.
4. **pnpm settings live in `pnpm-workspace.yaml`.** A `pnpm` block left in
   `package.json` is silently ignored, and a patched dependency then simply does
   not apply while the build stays green. Verify a patch by grepping
   `node_modules`, not by a clean install. See Workflow.
5. **Effect 4 rc versions must match exactly** across `effect` and every
   `@effect/*` package. `latest` on those is still Effect 3. See Version pins.
6. **Never kill by pattern.** `pkill -f vite` takes out your own harness and any
   other dev server. Kill the PID you started, or the port owner after checking it.

## Hit every surface

A change to chat behaviour has more entry points than the one you were asked about.
Before finishing, decide for each of these whether it applies, and say so if you
skipped one on purpose.

- **How the message got there**: send, retry, edit, structured answer to a
  clarification, branch, queue promotion, steer. Retry and edit re-resolve the agent, collections and
  skills inside the attempt transaction, before any reset.
- **Tool offer**: the composer's search and research toggles only decide what the
  attempt is _offered_; the model chooses. A `deep_research` call runs an
  investigation that sees a brief, never the conversation.
- **Display path**: the live SSE stream, the conversation-detail loader on reload,
  and a branch. All three project the same rows; a leak fixed in one is still open
  in the other two.
- **Tool families**: web, knowledge, skill, memory, ask, plan, notify, map, research, agent-draft,
  schedule-draft, document, project-file, desktop, custom, integration, presentation,
  spreadsheet, word, tool-file, tool-load, attachment.
  Each has its own envelope with a required `family`; there is no inference from shape.
- **Model kinds**: native tool calling and the Hermes polyfill for models without
  it, over either wire format (Chat Completions, Responses). The toolkit loop never
  learns the difference.
- **Reverse states**: every way in needs a way out. Stop, lease expiry, owner change
  and a stale run all have to leave the row terminal and the client consistent.
- **Docs**: if you changed a rule recorded in `docs/internals/`, rewrite the
  passage. Do not append.

## Running and verifying

- `pnpm dev:setup` provisions checkout-isolated Postgres state, then `pnpm dev`
  starts the web app through Portless and its isolated desktop shell together
  (`dev:web`, `dev:desktop` for one). Ctrl-C stops the terminal-owned runner;
  `dev:info` prints paths and the last URL, while `dev:destroy` retires only this
  checkout’s resources. Server module edits hot-swap the Effect runtime; no restart.
  The shell has no HMR: `dev:desktop` rebuilds and relaunches Electron on every
  change, and logs its build stamp (short sha and time) on start, so "is it running
  my change" has an answer in the terminal. The stamp is deliberately not in the UI.
  A fresh database opens at `/setup`, which creates the admin.
- Smallest proof first: the one test file you touched, with the right `--project`.
  Then `pnpm typecheck && pnpm lint && pnpm test` before calling work done. Lint
  has pre-existing warnings; zero errors is the bar. Report the counts you saw,
  not the ones you expected.
- `eslint-plugin-slop` runs through oxlint's JS plugin loader with full inspection.
  It rejects em dashes, comments over 50 words, inflated
  vocabulary in comments, chained type assertions, trivial wrappers and static-only
  classes. Fix the line; do not narrow lint coverage or disable the rule for the
  file.
- `@shadcn/lint` is the other JS plugin: it rejects a call site that changes a
  component's own spacing, shape or type scale, which means the wrong component
  was chosen or a variant is missing. `src/ui/**` is exempt, being the design
  system restating its own primitives. These are errors, and the count is zero:
  fix the call site, add the variant, or justify the exception in place with
  `// oxlint-disable-next-line shadcn/no-restyle -- why`. Widening the allow list
  buries the decision where nobody reads it. See [ui](docs/internals/ui.md).
- Lint config is `oxlint.config.ts`, typed through `defineConfig` and checked by
  `pnpm typecheck`, so a misspelled rule or plugin name fails there instead of
  being silently ignored. Adding `.oxlintrc.json` beside it is a hard error.
- Integration suites run in tens of seconds; run them in the background and read
  the result. Never `sleep` in a loop to wait.
- A test that only passes with a timeout or a sleep is wrong. Wait on the thing:
  a Deferred, a query, `pg_blocking_pids`.
- Tests assert real behaviour against real components. A fake gateway is fine; a
  test that mocks the unit under test is not. When a fixture would make the
  assertion vacuous (a hook that fires before the code path it claims to test),
  move it until it proves something.
- Browser checks against the running app are welcome for UI work, but they cost
  real provider calls when they send a message. Inspect state; do not generate.
- Every claim of "verified" in a report must rest on output you saw this session.

## Workflow

- Schema change: `pnpm db:generate`, commit `drizzle/`, `pnpm db:migrate`.
- Commits: imperative title under ~70 characters, body says problem then fix. One
  concern per commit; "and also" means split. Do not commit unless asked.
- `pnpm-workspace.yaml` holds `patchedDependencies`, `allowBuilds` (`electron` and
  `esbuild` are enabled; an unlisted package that wants a script is a hard error) and
  `minimumReleaseAge` (24h cooldown). `minimumReleaseAgeExclude` lists the pins
  deliberately tracked same-day; extend it rather than lowering the cooldown.
- UI primitives in `src/ui/primitives` are shadcn-generated. Regenerate with
  `pnpm dlx shadcn@latest add <component>`; answer no to overwriting `button.tsx`;
  remove the `next-themes` it adds and wire `~/ui/theme.tsx` instead.

## Documentation

- `docs/internals/` holds architectural decisions, cross-component constraints and
  hidden traps. Not features, not field lists, not control flow, not changelogs.
- A local reason goes in a code comment beside the code. A reason that crosses a
  module boundary goes in `docs/internals/`. Link, do not copy.
- When a decision changes, rewrite the passage. Never append a correction below
  the old text.
- This file is read every turn. Keep it to orientation, dangers and verification.
  Depth goes behind a link.

## Where the depth is

- `docs/internals/research.md`: deep research as a tool. The host turn owns context
  and the answer; the runner investigates a brief; the run is fenced by the
  generation that started it and ends without touching anything else.
- `docs/internals/knowledge-and-agents.md`: agents, sharing, collections, retrieval
  versus direct context, embedding widths, indexing and repair.
- `docs/internals/skills.md`: skill packages and their binary assets, revisions, ambient
  versus pinned, hardcoded builtins, import safety.
- `docs/internals/schedules.md`: cron cadences, claim semantics, catch-up-once,
  run conversations, model fallback, delete-mid-run, settling a run once.
- `docs/internals/notifications.md`: when a schedule notifies, settlement as the one sender,
  the unread mark, channels and their dedupe.
- `docs/internals/memory.md`: snapshot semantics, one save per generation, the
  transactional guard under research.
- `docs/internals/documents.md`: server-ordered ProseMirror steps, rebasing and offline
  recovery, block IDs and the XML view, guarded and streamed model edits, the one-writer hub.
- `docs/internals/files.md`: one classification for every stored file, the opaque `file`
  kind served only as a download, what the model sees, working drafts and publication.
- `docs/internals/pdf.md`: PDF reading in worker processes, what makes a page a scan, who reads
  scans (local OCR, Mistral, a vision model) and with whose consent, fingerprints and the
  per-page cache, waiting for scans in a chat and in knowledge.
- `docs/internals/presentations.md`: trusted PPTX operations in killable worker processes,
  visual feedback, fonts, preview authorization, preservation boundary and
  native-compatibility gate.
- `docs/internals/projects.md`: roles, private chats in a shared project, attempt-time
  access, project documents, files and memory, file retention, deletion.
- `docs/internals/custom-tools.md`: admin-authored TypeScript tools. The trust
  model, the `custom_` prefix contract, current module bundles and worker
  containment.
- `docs/internals/integrations.md`: connected services. Manifest and adapter, per-person
  connections and token refresh, OAuth bound to the starting browser, consent levels,
  schedule grants, knowledge sources.
- `docs/internals/queue.md`: queued messages, atomic promotion, steering at a safe
  boundary, queued files as a second owner kind, and why only a desktop app can
  start queued Work.
- `docs/internals/word.md`: Word files as numbered blocks per revision, templates by
  text replacement, measuring the package before the parser, structured previews.
- `docs/internals/sheets.md`: live sheets. Rows, columns and sheets by stable ID, formulas held by
  them, deletes as marks that move range endpoints inward, total deterministic apply, per-client
  sequence numbers.
- `docs/internals/spreadsheets.md`: Excel operations, our own formula engine on formula.js
  (dependency order, legacy versus dynamic-array formulas, parity with real Excel),
  containment and previews.
- `docs/internals/streaming.md`: answers generated apart from the request, numbered chunks,
  subscribe before replay so a reload or a second tab joins a running answer.
- `docs/internals/deployment.md`: the image, migrations on start, the shell-mode trap, and
  releases as drafts that a person rewrites and publishes.
- `docs/internals/resume.md`: continuing a failed or stopped last answer. Same row, new
  generation, one continuous chunk and turn space, earlier rounds read as records.
- `docs/internals/web-search.md`: the provider chain, why empty ends it, cooldowns that
  reorder and never remove, failure reasons, and each provider's quirks.
- `docs/internals/citations.md`: footnote-based citations, streamdown pins,
  markdown plugins.
- `docs/internals/temporary-chats.md`: the flag, where it is read, the sweep and
  what a branch or schedule does with one.
- `docs/internals/archived-chats.md`: the list and search predicates, what unarchives a chat
  and why a schedule's fire does not.
- `docs/internals/search.md`: the Cmd+K palette's sources, the `app_search`
  expression index for chat text, and what another search backend would need.
- `docs/internals/providers.md`: `@chat/model-client` and its presets, admin overrides,
  one finish and no truncated calls, replay units for reasoning state across rounds and turns,
  the two wire formats, Azure deployments, the opt-in live check, and the settings for
  services without a preset.
- `docs/internals/prompt-caching.md`: what must stay byte-stable before history,
  cache anchors and which providers need them.
- `docs/internals/compaction.md`: when a chat compacts, clearing results before
  summarizing, summaries that read the cached prompt, what stays beside them.
- `docs/internals/ui.md`: page shell, pending buttons, icons, copy rules, panel
  anatomy.
- `docs/internals/browser.md`: the desktop app's embedded browser. Webview guests gated
  by main, one profile per server, pages outside the routes laid over panel slots, the
  lifecycle that freezes and discards them, and the model's browser tools (desktop-family
  tools run by the page), site approvals and the navigation gate.
- `docs/internals/generative-ui.md`: ```ui blocks in answers. The language, the mutation
  contract that makes a rebuilt block equal the live one, and the QuickJS JSON boundary.
- `docs/internals/device-cache.md`: IndexedDB caches on the reader's device. One store keyed by
  owner and namespace, synchronous reads once warm, owner scoping and clearing on identity change.
- `docs/internals/desktop.md`: work chats, the desktop shell, the blocking
  handler and its timeout, containment, consent levels.

## Version pins

All release candidates. Pin exactly; never float to `latest`.

- `effect@4.0.0-rc.x` and every `@effect/*` package share the same rc
  (`@effect/vitest`, `@effect/sql-pg` are on the `rc` dist-tag). `latest` is
  Effect 3. `@chat/model-client` implements `effect/unstable/ai`'s `LanguageModel`;
  on a bump, run its tests and the provider tests in `apps/web` first.
- `drizzle-orm` / `drizzle-kit` are `1.0.0-rc.5-*` builds, kept as a matched pair.
  rc.4 crashes at import with effect >= 4.0.0-beta.104.
- `vitest` is v5 (peer of `@effect/vitest` rc). `katex` stays on 0.16 because
  `@streamdown/math` pins `rehype-katex@7`.
- `@office-kit/pptx-preview` is patched with `setFamilyResolver` so uploaded fonts render
  instead of the bundled substitutes. On a bump, check the substitution still runs through
  one function. pnpm applies patches without fuzz, so when the patched file moved,
  regenerate: drop the `patchedDependencies` entry, install, `pnpm patch` the new version,
  apply the old patch there with `patch -p1`, then `pnpm patch-commit`.
- `@dnd-kit/react`, `@dnd-kit/dom` and `@dnd-kit/abstract` are pre-1.0, pinned exact as a
  matched set; re-check the panel's tab dragging on a bump.
- `@tanstack/charts` is pre-alpha, pinned exact; re-probe the analytics charts on
  a bump.
- `@office-kit/xlsx` (pre-1.0, in apps/web) and `@formulajs/formulajs` (the one dependency
  of `packages/sheet`) are pinned exact. Formulas are calculated by our own engine on
  formula.js, not HyperFormula, which is GPL-3.0; keep the calculation MIT unless that
  decision is revisited. See
  [spreadsheets](docs/internals/spreadsheets.md).
- `@office-kit/docx` (pre-1.0) is pinned exact. It has no decompression limits, so the
  adapter measures every part first; re-check that on a bump. See [word](docs/internals/word.md).
- `onnxruntime-node` (with `onnxruntime-common`), `@napi-rs/canvas` and `pdf-lib` are pinned exact
  and stay external to the PDF worker bundle, traced by name in `vite.config.ts`. The ONNX
  install script only fetches CUDA files and is denied in `allowBuilds`. On a bump, run the OCR
  test in `pdf/server/pages.test.ts` with model files present and `pnpm build`, whose PDF worker
  smoke proves the natives load from the output. See [PDFs](docs/internals/pdf.md).
- `rolldown` needs no override since 1.2.7. Re-pin only if the production module
  check fails again.

## Effect 4 notes

Differs from most Effect 3 material online.

- Services: `class X extends Context.Service<X, Shape>()("id")`; layers are built
  with `Layer.effect`. No `.Default`, no `dependencies` option.
- `Schema.toStandardSchemaV1(schema)` for TanStack validators.
- `Effect.forkDetach` (was forkDaemon), `Fiber.join`, `PubSub.subscribe` needs a
  Scope, `Stream.fromEffectSchedule`, `Stream.toReadableStreamWith(stream, context)`.
- `Effect.catch` (not `catchAll`); `Effect.timeout` takes a `Duration`.
- `Effect.result` captures typed failures only; defects and interrupts pass through.
- Drizzle Effect client: `makeWithDefaults({ relations })` from
  `drizzle-orm/effect-postgres`, with `PgClient` provided at the composition root
  (`src/server/runtime.ts`). Publications share that pool; the reconnectable listener
  uses its configuration with one owned connection. See [sync](docs/internals/sync.md).
- A toolkit captures its handlers' context when merged. To give a handler a
  service, provide it around the merge, not only around the later call.

## Tool calling

- `LanguageModel.streamText` is one model turn. The multi-turn loop is ours
  (`src/modules/chat/server/streaming.ts`): re-run while `finish.reason` is
  `"tool-calls"`, feeding each round back with `roundPrompt`, which keeps the round's
  replay unit and its files' places.
- The model client emits exactly one `finish` per call, at `[DONE]` or a Responses
  terminal event, and fails a stream that ends with neither. Calls come only with it,
  never from a round cut off by its limit. See [providers](docs/internals/providers.md).
- Every model call streams, side generations included. `generateText` fails to
  decode against plain OpenAI-compatible servers (`system_fingerprint` required);
  `AiGateway.generateText` folds the stream instead.
- `ctx.preliminary(result)` streams progress as `tool-result` parts marked
  `preliminary: true`. UI only; keep them out of the continuation transcript.
- No-argument tools use `Tool.EmptyParams`, not `Schema.Struct({})`.
- A tool whose handler explains malformed input must make **every** parameter
  `Schema.optionalKey`. `streamText` decodes each part against the toolkit, so a
  required key the model omits or renames fails the whole generation with
  `Invalid output: Missing key` before any handler or alias table runs. A
  permissive value type does not cover an absent key. Build that permissive value on
  `Schema.Any` with a `toJsonSchema` filter declaring the real type: on `Schema.Unknown`
  the generator drops the annotation and the model is offered `{}` for every parameter,
  which smaller models answer with empty calls. `advertised-schemas.test.ts` guards it.
- `capabilities.tools` means native tool calling and gates nothing; a model
  without it goes through the Hermes polyfill (`hermes-tools.ts`), which must stay
  inside the provider boundary and return encoded parts. Malformed JSON and fenced
  examples are re-emitted as text, never as calls.
- Tool page bodies are never persisted; `message_tool_calls.result` holds the
  summary and source list only.
- Every web tool returns `WebToolResult`, so persistence, envelopes and the
  citations UI are written once. `read_url` is the only path through
  `PageExtractor`, which reads HTML, JSON, CSV and Markdown, and PDFs through the
  document parser; `url-safety.ts` is the SSRF boundary and the SearXNG base URL
  is exempt by design. After that check, callers must `fetchPinned` the returned
  addresses: a second DNS lookup would reopen rebinding.
- `web_search` caches per generation by query, time range and language; failures
  are evicted. Each query walks the ordered `search_providers` until one answers;
  empty is an answer, and a failing provider moves to the back, never out. Research
  shares `RESEARCH_LIMITS.externalOps` (3) permits, a query's fallbacks run inside
  its one permit, and SearXNG fans each query to every enabled engine, so that is the
  burst upstreams see. `infra/searxng/settings.yml` enables Google CSE, Yep, Yandex and Bing on purpose; its comment has the measurements.
- Search follows the composer toggle, which rests on the installed agent's "web
  search by default" (plain chat rests on true) and returns there after each send.
  The reader is armed with search, and also when user text or prior sources seed
  URL authority; assistant prose never grants authority. Retry uses the target's
  saved search setting capped by availability; edit uses the submitted choice.

## Invariants

- One live `ManagedRuntime` per process (`src/server/runtime.ts`). Dev HMR disposes
  the previous runtime itself because Vite never calls `import.meta.hot.dispose`
  for server modules.
- `message_chunks.seq` starts at 1 and is contiguous per message; resume relies on
  it.
- A streaming assistant row is only alive while its lease
  (`messages.generation_lease_until`) is in the future, judged by the database clock.
  Every flush renews it, including the empty ones the periodic flusher makes between
  chunks, or a slow first token would get a live answer reaped. That empty-batch
  renewal is a single self-fenced UPDATE, never the conversation lock: at four times
  a second it would otherwise queue ahead of the writes it exists to outlive. The engine reaps lapsed rows into `error` with what was
  streamed, on a timer and whenever a subscriber, the detail loader or Stop meets
  one. Research has its own lease on `research_runs`.
- Better Auth owns its tables' columns; `src/db/schema/auth.ts` tracks the
  installed version only (1.7.1 added `account.issuer`, 1.7.3 removed it). After
  an upgrade, diff `@better-auth/core`'s `dist/db/get-tables.mjs` and verify a
  fresh signup.
- Stored credentials (provider and tool API keys, OAuth client secrets, integration
  accounts) are AES-256-GCM at rest (`ENCRYPTION_KEY`); ciphertext
  never leaves the server.
- A desktop session is minted only by `/desktop/session` redeeming a browser
  ticket. The 90-day refresh and the Devices label "neema Desktop on …" key on
  the `ChatDesktop/` token stored on that session at redemption, not on the
  current request's user agent. A work attempt additionally stamps the sending
  install's machine id onto its generation config — attempt metadata for the
  foreign-chat banner, never auth. See `docs/internals/desktop.md`.
- The first signup claims a durable bootstrap owner before Better Auth inserts
  the user. `/setup` is the page for it and exists only while no claim does;
  sign-in and registration send there until then. Only that owner becomes admin and bypasses closed signup; a failed
  insert leaves the claim reserved, requiring quiesced operator repair rather
  than automatic re-election. To recover, stop account creation and wait for
  in-flight signups to finish, verify the claimed ID has no user row, then
  deliberately clear or transfer the claim before reopening signup. Do not
  bypass Better Auth for user creation.
  Missing approval rows deny access except for that claimed owner, whose row
  is repaired on read; other missing rows enter the pending queue. The migration
  claims existing installations, including those with users but no admin.
- `auth_settings.signup_policy` governs every route in, `/register` and OAuth
  alike, and is read on the creation it governs rather than captured at
  startup. `closed` refuses creation; `approval` still creates the account and
  leaves it unusable until an admin decides, which is what lets an OAuth
  redirect finish. Approval lives in `user_approvals`, not on `user`, because
  Better Auth owns that table's columns. A provider marked `trusted` admits its
  accounts straight away. A rejected account is kept, never deleted: deleting
  it would let the same person sign up again and reappear in the queue.
- Sign-in providers are rows in `oauth_providers`, secrets encrypted like
  provider API keys. Better Auth resolves its context once per instance, so
  that configuration is read once: every reader goes through `currentAuth()`,
  and an admin write calls `invalidateAuth()` so the next one rebuilds. A
  request already holding the old instance is unaffected, sessions being in the
  database. Both kinds of provider sign in through `signIn.social`, since
  `generic-oauth` registers an OpenID Connect entry as an ordinary social
  provider; one whose discovery document cannot be fetched is skipped at
  startup rather than reported.
- `IdentityBoundary` pins one identity per authenticated tree and replaces the
  document on any change. A `401` from any query or mutation ends the session;
  `requireSession` writes the fixed body `UNAUTHENTICATED_BODY` because the Start
  client keeps only a failed response's text. The focus revalidation exists for
  the case a `401` cannot catch (another tab switched account) and runs silently:
  hiding the tree via `<Activity hidden>` detached host refs, which Motion treats
  as a remount, so every entrance animation replayed on each tab return. Only the
  BFCache `pagehide` snapshot hides synchronously.
- `usage_events` is append-only, one row per attempt at finalize. Analytics reads
  only the ledger, never `messages.usage`.
- Physical bytes and rows cannot commit together, so `blob_cleanup_intents` records
  the risky half first: a `candidate` before an upload stores bytes, an `orphan` in
  the transaction that drops a blob's last reference. The reconciler settles them by
  asking whether any row still owns the key, never by trusting the caller's error,
  since registration may have committed anyway. Due-ness is judged by the database
  clock (`not_before <= now()` in SQL), never a JS `Date`: the two drift, and a
  reconciler that quietly sees nothing is the exact failure the ledger exists to
  prevent. Attachments, skills and knowledge all sit on this.
- Server functions sit behind TanStack's CSRF middleware (`src/start.ts`): a call
  must prove it is same-origin through `Sec-Fetch-Site`, `Origin` or `Referer`,
  and one sending none is refused with 403. Browsers, the desktop window
  included, send them; anything calling from outside a page uses `/api` routes.
- Nitro's dev middleware guesses static assets from `sec-fetch-dest`;
  `vite.config.ts` strips it for `/api/*` so `<img src="/api/files/:id">` works.
- jsdom applies no stylesheet: match accessible names with `\s?` where a browser
  would insert a space, and do not assert a gradient mask from the DOM.
  `VirtualMessageList` opts out of React Compiler memoization on purpose.

## Taste

- Find the real constraint and fight for the smallest model that makes the correct
  behaviour unsurprising. Do not keep complexity because it is there; do not add
  machinery that looks impressive.
- Design decisions in this codebase are not sacred. Much of it was written by
  agents. If something looks wrong, say so; do not defend it because a comment
  or a test describes it.
- Complexity at the adapter boundary; orchestration pure; UI dumb.
- Inferred types over annotations; no `any`.
- Comments say why, live beside the code, and move with it.
- Semantic colour tokens only. Curly apostrophes in user-facing copy. Every
  `HugeiconsIcon` carries `strokeWidth={2}`.
- If a rule here conflicts with the task, say so and get a human decision.
