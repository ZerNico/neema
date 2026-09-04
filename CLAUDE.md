# CLAUDE.md

Chat app — modular monolith. TanStack Start + Effect 4 (rc) + Drizzle 1 (rc) + Better Auth.
See README.md for architecture; this file records the sharp edges.

## Version pins (all release candidates — pin exactly, don't float to `latest`)

- `effect@4.0.0-rc.x` and every `@effect/*` package must share the SAME rc version
  (`@effect/vitest`, `@effect/sql-pg`, `@effect/ai-openrouter` are on the `rc` dist-tag).
  `latest` on those packages is still Effect 3 — never mix.
- `drizzle-orm` / `drizzle-kit` are on `1.0.0-rc.5-*` builds. rc.4 crashes at import time
  with effect >= 4.0.0-beta.104 (`Schema.TaggedErrorClass` was renamed to `Schema.TaggedError`).
- `vitest` must be v4 (peer of `@effect/vitest` rc).
- `@tanstack/charts` is pre-alpha — pinned exact (no caret); its API may change
  between releases, so re-probe the analytics charts on any bump.
- `rolldown` is overridden to `1.2.1`: 1.2.2–1.2.5 can emit an undeclared
  `ssr_exports` from Nitro's split SSR bundle ([#10734](https://github.com/rolldown/rolldown/issues/10734)).
  Keep the override until [#10743](https://github.com/rolldown/rolldown/pull/10743) ships in a
  release that passes the production module check and built-server smoke test.

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
- Search follows the per-message composer toggle. The reader rides with an armed
  search so the model can open its hits, and is also armed when user-authored text
  or prior persisted sources seed URL authority. Search hits extend that authority
  during the generation; assistant prose never does, so invented URLs are refused.
  `searchEnabled` gates search ONLY, history citation-marker stripping keys off
  whether any tool is armed (`webToolsEnabled`), and retry re-arms search only when
  the original generation called `web_search`.

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
- Citation numbers are conversation-scoped: `createSourceIndexer` is seeded from prior
  messages' persisted sources and shared by all web tools in a generation, so repeats
  keep their number and every tool continues one sequence.

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
  the installed better-auth version expects (1.7 added `account.issuer`). After a
  better-auth upgrade, verify against a fresh signup before shipping.
- Provider API keys are AES-256-GCM encrypted at rest (`PROVIDER_KEY_SECRET`, base64
  32 bytes); ciphertext never leaves the server (`toPublic` strips it).
- First registered user becomes admin via the `user.create.before` database hook — do not
  bypass Better Auth for user creation.
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
- `pnpm typecheck && pnpm lint && pnpm test` before considering work done.
  Integration tests need Docker (Testcontainers). Lint has exactly ONE known error
  (`virtual-message-list.tsx` react(incompatible-library) — React Compiler cannot memoize
  `useVirtualizer`, inherent to @tanstack/react-virtual); anything beyond it is new.
- UI primitives in `src/ui/primitives` are shadcn-generated (Base UI, style
  `base-luma`) — regenerate via `pnpm dlx shadcn@latest add <component>`, don't hand-roll.
  The CLI asks to overwrite `button.tsx` on every add (registry dependency); answer no.
  It also adds `next-themes` whenever a component's upstream reads the theme
  (`sonner`) — remove it and wire `~/ui/theme.tsx` instead, as `sonner.tsx` does.

## shadcn / UI conventions

- `src/styles/app.css` must keep `@import "tw-animate-css"` and
  `@import "shadcn/tailwind.css"` right after `@import "tailwindcss"`. Every
  `data-open:animate-in` / `fade-in-0` / `zoom-in-95` class in the overlay primitives
  comes from `tw-animate-css`; without it overlays pop with no transition and nothing
  errors. `shadcn/tailwind.css` supplies the `data-open`/`data-closed`/... variants.
  The `button { cursor: pointer }` base rule is shadcn's `init --pointer` snippet —
  Tailwind v4 dropped it.
- `cn` is the `cn` package (shadcn's `twMerge(clsx())` replacement); `src/ui/utils.ts`
  only re-exports it. Primitives import from `"cn"` directly (what the CLI emits).
- Pending buttons keep their label: `<Spinner data-icon="inline-start" aria-hidden />`
  ahead of the text, `disabled`, `aria-busy`. Never swap the label for `"Saving…"` —
  it reflows the button. `form.SubmitButton` in `src/ui/form/app-form.tsx` does this.
- `Spinner` is `role="status"` on its own; pass `aria-hidden` inside any control that
  already has a label or `aria-busy`, or assistive tech announces "Loading" twice.
- Icons inside a labelled `Button`/`Badge` carry `data-icon="inline-start|inline-end"`;
  the size variants key their optical padding off it. Never `<Button render={<Link/>}
nativeButton={false}>` for navigation — Base UI forces `role="button"`; use
  `<Link className={buttonVariants({...})}>`.
- Page chrome lives in `src/ui/page-shell.tsx` (`SectionShell`, `Page`, `Section`,
  `ListCard`/`ListRow`, `EmptyState`, `ErrorState`); admin, settings, tools and the
  chats index all use it. Confirmations go through `useConfirm()` (AlertDialog);
  non-inline mutation failures go through `toast` from `sonner` (Toaster mounted in
  `__root.tsx`).
- Radius scale is 2xl/3xl/4xl (rows/cards/buttons). Semantic colour tokens only —
  `success` and `warning` exist alongside `destructive`; `text-2xs` is the one size
  below `text-xs`.
